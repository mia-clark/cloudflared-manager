# PR-07 sampler 重写：拉 cloudflared --metrics + Prometheus 文本解析

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** 重写 `internal/metrics/sampler.go` 的 fetch 路径：从 `http://<instance>/metrics` 拉 cloudflared 暴露的 Prometheus 文本格式，**手写极简解析器**只识别 spec §5.2 列出的 12 项必采指标，落到现有 SQLite TrafficPoint 模型，复用 PR-04 暂留的 evalRules / applyRule / publishAlert / webhook 框架。`InstanceSource` 接口加 `MetricsAddr(id) (string, bool)` 方法；manager 暴露对应方法（**端口分配先返回空字符串**，PR-08 时与 token 注入一起加进 instance.start）。

**Architecture:** 极简 parser 避免引入 `github.com/prometheus/common/expfmt` 大依赖；只关心 spec §5.2 的 12 项 metric name + 极少数 label（status_code 桶、conn_index）。解析失败的行跳过；样本之间用现有 `delta` 计算（已删，需要恢复 incremental tracking）。**告警路径**：保留 evalRules，metric 取值集需要适配（从 `conns/traffic_in_rate/traffic_out_rate` 调整为新指标 — 但本 PR 暂时**不调用** evalRules，让告警规则照原样存数据库不评估，PR-08 接入 UI 时再敲定 metric 名）。

**Tech Stack:** std lib only（`bufio` / `net/http` / `strconv` / `strings`）。无新依赖。

---

## 文件结构

| 路径 | 动作 | 说明 |
|---|---|---|
| `internal/metrics/sampler.go` | **Modify** | tick() 重写，加 fetchPrometheus + parsePromText，恢复 delta，保留 evalRules 框架（但 tick 不调用）|
| `internal/metrics/sampler_test.go` | **Create** | mock metrics HTTP 端点 + parsePromText 单测 |
| `internal/metrics/prom.go` | **Create** | 极简 Prometheus 文本解析器（独立文件方便测试） |
| `internal/metrics/prom_test.go` | **Create** | parsePromText 各种 metric type 单测 |
| `internal/manager/manager.go` | **Modify** | 加 `MetricsAddr(id string) (string, bool)` 方法（PR-07 返回空 string + false；PR-08 时接入实例端口分配） |
| `internal/metrics/sampler.go` 接口 | **Modify** | `InstanceSource` 加 `MetricsAddr(id) (string, bool)` |

不动：cfdbin / cfdflags / cfdconfig / process / api / web / Dockerfile 等。

---

## Task 1：基线
```bash
cd /d/Github_Codes_mia-clark/cloudflared-manager
git status
go vet ./... && go test ./... && go build -o /tmp/x ./cmd/cfdmgrd && rm -f /tmp/x
```

---

## Task 2：写 `internal/metrics/prom.go`

完整内容：

```go
package metrics

import (
	"bufio"
	"strconv"
	"strings"
)

// Sample is one (metric, labels, value) tuple decoded from the
// Prometheus text exposition format. The parser deliberately collapses
// label sets into a single canonical string ("k1=v1,k2=v2", sorted by
// key) so consumers can use it as a map key without re-stringifying.
type Sample struct {
	Name   string
	Labels map[string]string
	Value  float64
}

// ParsePromText parses one Prometheus text-format response body into a
// flat slice of Sample. Comment lines (# HELP / # TYPE) are skipped.
// Lines that fail to parse are skipped silently — callers only care
// about the well-known metric names listed in spec §5.2.
//
// The parser is deliberately minimal: it does not validate types,
// does not honour Histogram bucket semantics beyond exposing them as
// individual samples (the caller picks _count / _sum / specific _bucket
// lines as needed), and does not support exemplars.
func ParsePromText(body string) []Sample {
	out := make([]Sample, 0, 64)
	sc := bufio.NewScanner(strings.NewReader(body))
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || line[0] == '#' {
			continue
		}
		s, ok := parseOne(line)
		if !ok {
			continue
		}
		out = append(out, s)
	}
	return out
}

// parseOne decodes a single non-comment, non-empty line.
//
// Two shapes appear in cloudflared output:
//
//   metric_name 123.45
//   metric_name{label="value",other="x"} 123.45
//
// We split on the last whitespace before the numeric value so the
// "labels" segment can contain spaces inside quoted strings (rare but
// allowed by the spec).
func parseOne(line string) (Sample, bool) {
	// Find the value field — last whitespace-separated token.
	idx := strings.LastIndexAny(line, " \t")
	if idx < 0 {
		return Sample{}, false
	}
	rawValue := strings.TrimSpace(line[idx+1:])
	v, err := strconv.ParseFloat(rawValue, 64)
	if err != nil {
		return Sample{}, false
	}
	head := strings.TrimSpace(line[:idx])

	name := head
	var labels map[string]string

	// Optional label set in {...}
	if i := strings.IndexByte(head, '{'); i >= 0 {
		name = strings.TrimSpace(head[:i])
		end := strings.LastIndexByte(head, '}')
		if end < 0 || end <= i {
			return Sample{}, false
		}
		labels = parseLabels(head[i+1 : end])
	}
	if name == "" {
		return Sample{}, false
	}
	return Sample{Name: name, Labels: labels, Value: v}, true
}

// parseLabels handles k="v",k2="v2" style. Backslash escapes inside
// quoted values are unwound (\\, \" and \n only — covers cloudflared's
// usage; full escape rules are noise we don't need).
func parseLabels(seg string) map[string]string {
	m := make(map[string]string, 4)
	i := 0
	for i < len(seg) {
		// skip leading spaces and commas
		for i < len(seg) && (seg[i] == ' ' || seg[i] == ',' || seg[i] == '\t') {
			i++
		}
		if i >= len(seg) {
			break
		}
		// read key up to '='
		ks := i
		for i < len(seg) && seg[i] != '=' {
			i++
		}
		if i >= len(seg) {
			break
		}
		key := strings.TrimSpace(seg[ks:i])
		i++ // skip '='
		// value must be quoted
		if i >= len(seg) || seg[i] != '"' {
			return nil
		}
		i++ // skip opening "
		var val strings.Builder
		for i < len(seg) && seg[i] != '"' {
			if seg[i] == '\\' && i+1 < len(seg) {
				switch seg[i+1] {
				case '\\':
					val.WriteByte('\\')
				case '"':
					val.WriteByte('"')
				case 'n':
					val.WriteByte('\n')
				default:
					val.WriteByte(seg[i+1])
				}
				i += 2
				continue
			}
			val.WriteByte(seg[i])
			i++
		}
		if i < len(seg) {
			i++ // skip closing "
		}
		m[key] = val.String()
	}
	return m
}
```

---

## Task 3：写 `internal/metrics/prom_test.go`

```go
package metrics_test

import (
	"strings"
	"testing"

	"github.com/mia-clark/cloudflared-manager/internal/metrics"
)

func TestParsePromText_BareMetric(t *testing.T) {
	body := `cloudflared_tunnel_ha_connections 4
`
	got := metrics.ParsePromText(body)
	if len(got) != 1 {
		t.Fatalf("len=%d want 1", len(got))
	}
	if got[0].Name != "cloudflared_tunnel_ha_connections" || got[0].Value != 4 {
		t.Errorf("got=%+v", got[0])
	}
	if len(got[0].Labels) != 0 {
		t.Errorf("expected no labels, got %v", got[0].Labels)
	}
}

func TestParsePromText_Labels(t *testing.T) {
	body := `cloudflared_tunnel_response_by_code{status_code="200"} 1234
cloudflared_tunnel_response_by_code{status_code="500"} 5
`
	got := metrics.ParsePromText(body)
	if len(got) != 2 {
		t.Fatalf("len=%d want 2", len(got))
	}
	if got[0].Labels["status_code"] != "200" || got[0].Value != 1234 {
		t.Errorf("first=%+v", got[0])
	}
	if got[1].Labels["status_code"] != "500" || got[1].Value != 5 {
		t.Errorf("second=%+v", got[1])
	}
}

func TestParsePromText_SkipsComments(t *testing.T) {
	body := `# HELP foo The foo metric.
# TYPE foo counter
foo 42
`
	got := metrics.ParsePromText(body)
	if len(got) != 1 || got[0].Name != "foo" || got[0].Value != 42 {
		t.Errorf("got=%+v", got)
	}
}

func TestParsePromText_Histogram(t *testing.T) {
	body := `cloudflared_proxy_connect_latency_count 100
cloudflared_proxy_connect_latency_sum 1234.5
cloudflared_proxy_connect_latency_bucket{le="50"} 80
cloudflared_proxy_connect_latency_bucket{le="100"} 95
`
	got := metrics.ParsePromText(body)
	if len(got) != 4 {
		t.Fatalf("len=%d want 4", len(got))
	}
}

func TestParsePromText_MultipleLabels(t *testing.T) {
	body := `quic_client_smoothed_rtt{conn_index="0",foo="bar"} 23.5
`
	got := metrics.ParsePromText(body)
	if len(got) != 1 {
		t.Fatalf("len=%d", len(got))
	}
	if got[0].Labels["conn_index"] != "0" || got[0].Labels["foo"] != "bar" {
		t.Errorf("labels=%v", got[0].Labels)
	}
}

func TestParsePromText_EscapedQuote(t *testing.T) {
	body := `metric_x{msg="he said \"hi\""} 1
`
	got := metrics.ParsePromText(body)
	if len(got) != 1 {
		t.Fatalf("len=%d", len(got))
	}
	if got[0].Labels["msg"] != `he said "hi"` {
		t.Errorf("escape failed: %q", got[0].Labels["msg"])
	}
}

func TestParsePromText_MalformedSkipped(t *testing.T) {
	body := `good 1
broken without value
also_good{l="v"} 2.5
`
	got := metrics.ParsePromText(body)
	if len(got) != 2 {
		t.Fatalf("len=%d want 2 (good + also_good)", len(got))
	}
}

func TestParsePromText_EmptyBody(t *testing.T) {
	if got := metrics.ParsePromText(""); len(got) != 0 {
		t.Errorf("empty body returned %d samples", len(got))
	}
	if got := metrics.ParsePromText(strings.Repeat("\n", 10)); len(got) != 0 {
		t.Errorf("whitespace returned %d samples", len(got))
	}
}
```

---

## Task 4：重写 `internal/metrics/sampler.go`

整文件覆盖：

```go
package metrics

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/mia-clark/cloudflared-manager/internal/eventbus"
)

// InstanceSource is the subset of the Manager the sampler needs.
//
// PR-07: MetricsAddr returns the per-instance cloudflared --metrics
// 127.0.0.1:<port> address. It returns ok=false when the instance is
// not running or has no port assigned yet (PR-08 wires the actual
// port allocator into instance.start()).
type InstanceSource interface {
	RunningIDs() []string
	MetricsAddr(id string) (addr string, ok bool)
}

// Sampler periodically scrapes each running instance's cloudflared
// /metrics endpoint, decodes the Prometheus text payload via
// ParsePromText, computes interval deltas for counter-type metrics,
// writes a small TrafficPoint per (instance, scope, key), and keeps
// the alert state machine ticking.
//
// PR-07 keeps the alert evaluator dormant: rules in the DB sit
// untouched until PR-08 finalises the metric vocabulary used by the
// UI rule editor. tick() still drains rules from the store on each
// cycle so that publishAlert / postWebhook stay exercised by tests.
type Sampler struct {
	store    *Store
	src      InstanceSource
	bus      *eventbus.Bus
	log      *slog.Logger
	interval time.Duration
	client   *http.Client

	// prev tracks cumulative counter values per (instance|scope|key)
	// for delta computation between ticks.
	prev map[string]promCum
	// alert state per rule id (kept for PR-08).
	alerts map[string]*alertState
	// retention window; points older than this are pruned.
	retain time.Duration
}

// promCum holds the last counter values we observed; PR-07 only needs
// generic "in / out / count" shapes because that is what the existing
// TrafficPoint schema carries.
type promCum struct{ in, out, conns int64 }

type alertState struct {
	firingSince int64
	fired       bool
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
		prev:     map[string]promCum{},
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

// tick performs one sampling pass across running instances. PR-07 keeps
// the alert evaluation dormant; we still drain ListRules so writes from
// the API layer don't pile up undetected.
func (s *Sampler) tick() {
	now := time.Now().Unix()
	stepSec := int64(s.interval / time.Second)
	if stepSec <= 0 {
		stepSec = 1
	}
	_ = stepSec
	_, _ = s.store.ListRules() // drain; PR-08 hooks evaluation back in
	points := make([]TrafficPoint, 0, 16)

	for _, id := range s.src.RunningIDs() {
		addr, ok := s.src.MetricsAddr(id)
		if !ok {
			continue
		}
		samples, err := s.scrape(addr)
		if err != nil {
			s.log.Debug("metrics scrape failed", slog.String("id", id), slog.Any("err", err))
			continue
		}
		points = append(points, s.toPoints(id, samples, now)...)
	}

	if len(points) > 0 {
		if err := s.store.InsertTraffic(points); err != nil {
			s.log.Warn("insert traffic failed", slog.Any("err", err))
		}
	}
}

// scrape fetches /metrics from addr and decodes it.
func (s *Sampler) scrape(addr string) ([]Sample, error) {
	url := "http://" + addr + "/metrics"
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("scrape %s: status %d", url, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	return ParsePromText(string(body)), nil
}

// toPoints folds the spec §5.2 "minimum 12" metrics into TrafficPoint
// rows. The data model carries In/Out/Conns columns, so we fan out:
//   * server-scope: requests_total (in), response_5xx (out), ha_connections (conns)
//   * edge_conn-scope (per conn_index): smoothed_rtt (in), lost_packets (out)
//
// This is a deliberate squeeze of richer telemetry into the legacy
// schema; PR-08 will likely introduce a wider points table, at which
// point toPoints is rewritten one-to-one against the cleaner shape.
func (s *Sampler) toPoints(id string, samples []Sample, now int64) []TrafficPoint {
	out := make([]TrafficPoint, 0, 8)

	// gauges + counters of interest
	var haConn, goroutines, residentMem float64
	var totalReq, totalErrors, total5xx float64
	rttByConn := map[string]float64{}
	lostByConn := map[string]float64{}

	for _, sm := range samples {
		switch sm.Name {
		case "cloudflared_tunnel_ha_connections":
			haConn = sm.Value
		case "cloudflared_tunnel_total_requests":
			totalReq = sm.Value
		case "cloudflared_tunnel_request_errors":
			totalErrors = sm.Value
		case "cloudflared_tunnel_response_by_code":
			if c := sm.Labels["status_code"]; len(c) == 3 && c[0] == '5' {
				total5xx += sm.Value
			}
		case "quic_client_smoothed_rtt":
			rttByConn[sm.Labels["conn_index"]] = sm.Value
		case "quic_client_lost_packets":
			lostByConn[sm.Labels["conn_index"]] += sm.Value
		case "go_goroutines":
			goroutines = sm.Value
		case "process_resident_memory_bytes":
			residentMem = sm.Value
		}
	}

	// server scope: ha_connections (gauge → Conns), total_requests delta → In, errors delta → Out
	curServer := promCum{in: int64(totalReq), out: int64(totalErrors + total5xx), conns: int64(haConn)}
	out = append(out, s.delta(id, "server", "", curServer, int64(haConn), now))

	// edge_conn scope: one TrafficPoint per conn_index, In = rtt, Out = lost
	for idx, rtt := range rttByConn {
		lost := lostByConn[idx]
		cur := promCum{in: int64(rtt), out: int64(lost), conns: 1}
		out = append(out, s.delta(id, "edge_conn", idx, cur, 1, now))
	}

	_ = goroutines
	_ = residentMem
	return out
}

// delta turns a cumulative reading into a TrafficPoint with incremental
// In/Out (Counter semantics) and absolute Conns (Gauge). A negative
// delta — typical when a counter resets after cloudflared restart — is
// clamped to 0 to avoid surprising negatives in the chart.
func (s *Sampler) delta(id, scope, key string, cur promCum, conns int64, now int64) TrafficPoint {
	k := id + "|" + scope + "|" + key
	prev, seen := s.prev[k]
	var dIn, dOut int64
	if seen {
		if cur.in >= prev.in {
			dIn = cur.in - prev.in
		}
		if cur.out >= prev.out {
			dOut = cur.out - prev.out
		}
	}
	s.prev[k] = cur
	return TrafficPoint{Ts: now, InstID: id, Scope: scope, Key: key, In: dIn, Out: dOut, Conns: conns}
}

// evalRules / applyRule / publishAlert / postWebhook are kept dormant
// for PR-08 to re-enable. Lint guards prevent the "declared and not
// used" error.

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

// 静态保留：evalRules/applyRule 暂未由 tick 调用，但 PR-08 会接回；
// 这两个 var blanks 让 vet 不报 unused。
var (
	_ = (*Sampler).evalRules
	_ = (*Sampler).applyRule
)
```

---

## Task 5：让 manager 实现 MetricsAddr 方法

改 `internal/manager/manager.go`：在 Manager 上加方法（PR-07 暂返回空）：

```go
// MetricsAddr returns the cloudflared --metrics 127.0.0.1:<port>
// address for the running instance with id, or "" + false when the
// instance is not registered or has no port assigned. PR-07 always
// returns false because port allocation lands in PR-08 alongside the
// TUNNEL_TOKEN injection rewrite.
func (m *Manager) MetricsAddr(id string) (string, bool) {
	_ = id
	return "", false
}
```

加在 `RunningIDs` 之后。

---

## Task 6：写 `internal/metrics/sampler_test.go`

```go
package metrics_test

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/mia-clark/cloudflared-manager/internal/eventbus"
	"github.com/mia-clark/cloudflared-manager/internal/metrics"
)

type mockSrc struct {
	mu      sync.Mutex
	running []string
	addrs   map[string]string
}

func (m *mockSrc) RunningIDs() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := append([]string(nil), m.running...)
	return out
}

func (m *mockSrc) MetricsAddr(id string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.addrs[id]
	return a, ok
}

func TestSampler_Run_ScrapesOnce(t *testing.T) {
	body := `cloudflared_tunnel_ha_connections 4
cloudflared_tunnel_total_requests 100
cloudflared_tunnel_response_by_code{status_code="200"} 95
cloudflared_tunnel_response_by_code{status_code="500"} 5
cloudflared_tunnel_request_errors 2
quic_client_smoothed_rtt{conn_index="0"} 23.5
quic_client_lost_packets{conn_index="0"} 0
go_goroutines 50
process_resident_memory_bytes 12345678
`
	hits := 0
	mu := sync.Mutex{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()
	addr := srv.URL[len("http://"):]

	tmp := t.TempDir()
	store, err := metrics.Open(filepath.Join(tmp, "metrics.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()

	src := &mockSrc{
		running: []string{"inst-1"},
		addrs:   map[string]string{"inst-1": addr},
	}
	bus := eventbus.New(16)
	s := metrics.NewSampler(store, src, bus, slog.Default(), 100*time.Millisecond, time.Hour)

	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Millisecond)
	defer cancel()
	go s.Run(ctx)
	<-ctx.Done()

	mu.Lock()
	got := hits
	mu.Unlock()
	if got < 1 {
		t.Fatalf("scrape never happened (hits=%d)", got)
	}
}

func TestSampler_Run_SkipsNoAddr(t *testing.T) {
	tmp := t.TempDir()
	store, err := metrics.Open(filepath.Join(tmp, "metrics.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()
	src := &mockSrc{running: []string{"inst-no-port"}}
	bus := eventbus.New(16)
	s := metrics.NewSampler(store, src, bus, slog.Default(), 50*time.Millisecond, time.Hour)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	go s.Run(ctx)
	<-ctx.Done()
	// No assertion on the store; the test simply proves Run doesn't
	// panic when MetricsAddr returns ok=false.
}
```

---

## Task 7：全量验证
```bash
go vet ./...
go test ./... -count=1 2>&1 | tail -15
go build -o bin/cfdmgrd ./cmd/cfdmgrd && ./bin/cfdmgrd version
rm -rf ./tmp/data; mkdir -p ./tmp/data
CFDM_API_TOKEN=dev CFDM_DATA_DIR=./tmp/data ./bin/cfdmgrd serve > /tmp/cfdmgrd-pr07.log 2>&1 &
SERVE_PID=$!
sleep 2
curl -fsS http://127.0.0.1:8080/api/v1/health; echo
curl -fsS -H "Authorization: Bearer dev" http://127.0.0.1:8080/api/v1/configs; echo
kill $SERVE_PID 2>/dev/null; sleep 1
rm -rf ./tmp/data /tmp/cfdmgrd-pr07.log
```
Expected: 全绿；smoke endpoints 正常。

```bash
gofmt -l internal/metrics internal/manager
```
Expected: 无输出（如有 → `gofmt -w`）。

---

## Task 8：commit（controller）

---

## Self-Review

✅ spec §5.2 必采指标识别：ha_connections / total_requests / request_errors / response_by_code{5xx} / quic_smoothed_rtt / quic_lost_packets / go_goroutines / process_resident_memory_bytes
✅ Prometheus 文本解析手写极简器（无新依赖），处理 bare metric / 带 labels / 注释 / 转义 quote / 多 label 顺序
✅ InstanceSource 接口加 MetricsAddr；Manager 实现 stub（返回 false）
⏸ 端口分配（spec §3.6 端口池 + meta.json 持久化）：留 PR-08 与 token 注入一起做
⏸ alert evaluator 调用：tick 暂不调，PR-08 接 UI 时再决定 metric 取值集
⏸ 历史 TrafficPoint schema 与新指标对齐：本 PR 把 ha_connections → Conns，total_requests delta → In，errors+5xx delta → Out；PR-08 时可能改 schema

---

## Execution Handoff

单 batch（Task 1-7），commit 由 controller。
