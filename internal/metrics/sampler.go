package metrics

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/mia-clark/cloudflared-manager/internal/eventbus"
)

// InstanceSource is the subset of the Manager the sampler needs.
//
// PR-04 transitional shape: only RunningIDs is required. The previous
// Loopback method (for poking the frps worker's mem endpoint) is gone
// along with the re-exec-self worker model. PR-07 will add a
// MetricsAddr(id) method that returns the per-instance cloudflared
// --metrics 127.0.0.1:<port> address and rewrite tick() to scrape
// Prometheus text format from there.
type InstanceSource interface {
	RunningIDs() []string
}

// Sampler periodically evaluates alert rules against the time-series
// store. PR-04 leaves the sampling pipeline as a no-op — RunningIDs is
// still drained each tick to keep the manager → metrics interface
// exercised, but no traffic points are inserted because there is no
// data source to poll. The alert state machine, store / event bus
// plumbing and webhook delivery code are kept intact so PR-07 only has
// to wire the new fetcher in.
type Sampler struct {
	store    *Store
	src      InstanceSource
	bus      *eventbus.Bus
	log      *slog.Logger
	interval time.Duration
	client   *http.Client

	// alert state per rule id (kept for PR-07's re-use).
	alerts map[string]*alertState
	// retention window; points older than this are pruned
	retain time.Duration
}

type alertState struct {
	firingSince int64 // unix sec when condition first held; 0 if not holding
	fired       bool  // whether a firing event is currently open
}

// NewSampler builds a sampler. interval<=0 defaults to 10s; retain<=0 to 7d.
func NewSampler(store *Store, src InstanceSource, bus *eventbus.Bus, log *slog.Logger, interval, retain time.Duration) *Sampler {
	if interval <= 0 {
		interval = 10 * time.Second
	}
	if retain <= 0 {
		retain = 7 * 24 * time.Hour
	}
	if log == nil {
		log = slog.Default()
	}
	return &Sampler{
		store:    store,
		src:      src,
		bus:      bus,
		log:      log,
		interval: interval,
		client:   &http.Client{Timeout: 4 * time.Second},
		alerts:   map[string]*alertState{},
		retain:   retain,
	}
}

// Run blocks, sampling every interval until ctx is cancelled.
func (s *Sampler) Run(ctx context.Context) {
	t := time.NewTicker(s.interval)
	defer t.Stop()
	prune := time.NewTicker(time.Hour)
	defer prune.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.tick()
		case <-prune.C:
			cutoff := time.Now().Add(-s.retain).Unix()
			if n, err := s.store.PruneBefore(cutoff); err == nil && n > 0 {
				s.log.Debug("pruned old traffic points", slog.Int64("rows", n))
			}
		}
	}
}

// tick is intentionally a no-op for the PR-04 transition.
//
// We still drain RunningIDs so the InstanceSource interface stays
// exercised (and a future PR-07 fetcher slots in without retyping the
// loop), but no traffic points are produced because the frps
// loopback mem endpoint is gone and the cloudflared --metrics scraper
// has not landed yet.
func (s *Sampler) tick() {
	_ = s.src.RunningIDs()
}

// evalRules / applyRule / publishAlert / postWebhook below are kept
// intact for PR-07 to re-use once tick() starts producing real points.

// evalRules evaluates all rules that apply to (instID, target) for one sample.
func (s *Sampler) evalRules(rules []AlertRule, instID, target string, conns int64, pt TrafficPoint, stepSec, now int64) {
	for _, r := range rules {
		if !r.Enabled {
			continue
		}
		if r.InstID != "*" && r.InstID != instID {
			continue
		}
		ruleTarget := r.Target
		if ruleTarget == "*" {
			ruleTarget = ""
		}
		if ruleTarget != target {
			continue
		}
		var value float64
		switch r.Metric {
		case "conns":
			value = float64(conns)
		case "traffic_in_rate":
			value = float64(pt.In) / float64(stepSec)
		case "traffic_out_rate":
			value = float64(pt.Out) / float64(stepSec)
		default:
			continue
		}
		s.applyRule(r, instID, target, value, now)
	}
}

func (s *Sampler) applyRule(r AlertRule, instID, target string, value float64, now int64) {
	st := s.alerts[r.ID]
	if st == nil {
		st = &alertState{}
		s.alerts[r.ID] = st
	}
	breached := compare(value, r.Op, r.Threshold)
	if breached {
		if st.firingSince == 0 {
			st.firingSince = now
		}
		held := now - st.firingSince
		if !st.fired && held >= int64(r.ForSeconds) {
			st.fired = true
			ev := AlertEvent{
				ID:     fmt.Sprintf("ae_%s_%d", r.ID, now),
				RuleID: r.ID, InstID: instID, Target: target,
				FiredAt: now, Value: value, State: "firing",
			}
			_ = s.store.InsertEvent(ev)
			s.publishAlert(ev, r)
		}
	} else {
		if st.fired {
			st.fired = false
			_ = s.store.ResolveEvent(r.ID, now)
			ev := AlertEvent{
				ID:     fmt.Sprintf("ae_%s_%d_r", r.ID, now),
				RuleID: r.ID, InstID: instID, Target: target,
				FiredAt: st.firingSince, ResolvedAt: now, Value: value, State: "resolved",
			}
			s.publishAlert(ev, r)
		}
		st.firingSince = 0
	}
}

func compare(v float64, op string, th float64) bool {
	switch op {
	case ">":
		return v > th
	case ">=":
		return v >= th
	case "<":
		return v < th
	case "<=":
		return v <= th
	}
	return false
}

// publishAlert emits an eventbus event and, if configured, POSTs a webhook.
func (s *Sampler) publishAlert(ev AlertEvent, r AlertRule) {
	if s.bus != nil {
		s.bus.Publish(eventbus.TypeAlert, ev.InstID, map[string]any{
			"rule_id": ev.RuleID, "rule_name": r.Name, "target": ev.Target,
			"state": ev.State, "value": ev.Value, "threshold": r.Threshold,
			"metric": r.Metric, "fired_at": ev.FiredAt, "resolved_at": ev.ResolvedAt,
		})
	}
	if r.Webhook != "" {
		go s.postWebhook(r.Webhook, ev, r)
	}
}

func (s *Sampler) postWebhook(url string, ev AlertEvent, r AlertRule) {
	payload, _ := json.Marshal(map[string]any{
		"rule_id": ev.RuleID, "rule_name": r.Name, "inst_id": ev.InstID,
		"target": ev.Target, "metric": r.Metric, "op": r.Op, "threshold": r.Threshold,
		"value": ev.Value, "state": ev.State, "fired_at": ev.FiredAt, "resolved_at": ev.ResolvedAt,
	})
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		s.log.Warn("alert webhook failed", slog.String("rule", r.ID), slog.Any("err", err))
		return
	}
	_ = resp.Body.Close()
}
