package metrics

import (
	"path/filepath"
	"testing"
)

func openTmp(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.ping(); err != nil {
		t.Fatalf("ping: %v", err)
	}
	return s
}

// TestTrafficRoundTrip: 写入点后按 step 降采样查询应聚合正确。
func TestTrafficRoundTrip(t *testing.T) {
	s := openTmp(t)
	pts := []TrafficPoint{
		{Ts: 100, InstID: "a", Scope: "server", Key: "", In: 10, Out: 5, Conns: 2},
		{Ts: 110, InstID: "a", Scope: "server", Key: "", In: 20, Out: 5, Conns: 3},
		{Ts: 250, InstID: "a", Scope: "server", Key: "", In: 7, Out: 1, Conns: 1},
		{Ts: 100, InstID: "b", Scope: "server", Key: "", In: 99, Out: 99, Conns: 9}, // 不同实例
	}
	if err := s.InsertTraffic(pts); err != nil {
		t.Fatalf("InsertTraffic: %v", err)
	}
	// step=100 → bucket 100 含 ts100+ts110 (In=30,Out=10,maxConns=3)，bucket 200 含 ts250
	series, err := s.QueryTraffic("a", "server", "", 0, 1000, 100)
	if err != nil {
		t.Fatalf("QueryTraffic: %v", err)
	}
	if len(series) != 2 {
		t.Fatalf("expected 2 buckets, got %d: %+v", len(series), series)
	}
	if series[0].In != 30 || series[0].Out != 10 || series[0].Conns != 3 {
		t.Fatalf("bucket0 = %+v, want In30 Out10 Conns3", series[0])
	}
	if series[1].In != 7 {
		t.Fatalf("bucket1 In = %d, want 7", series[1].In)
	}
}

// TestAlertRuleCRUD: 规则增改查删 + 事件写入/解除往返。
func TestAlertRuleCRUD(t *testing.T) {
	s := openTmp(t)
	r := AlertRule{ID: "r1", Name: "高连接数", Enabled: true, InstID: "*",
		Metric: "conns", Op: ">", Threshold: 100, ForSeconds: 30, Target: "", Webhook: ""}
	if err := s.UpsertRule(r); err != nil {
		t.Fatalf("UpsertRule: %v", err)
	}
	got, ok, err := s.GetRule("r1")
	if err != nil || !ok {
		t.Fatalf("GetRule ok=%v err=%v", ok, err)
	}
	if got.Name != "高连接数" || got.Threshold != 100 || !got.Enabled {
		t.Fatalf("rule round-trip mismatch: %+v", got)
	}
	// update
	r.Threshold = 200
	if err := s.UpsertRule(r); err != nil {
		t.Fatalf("update: %v", err)
	}
	got, _, _ = s.GetRule("r1")
	if got.Threshold != 200 {
		t.Fatalf("update not applied: %v", got.Threshold)
	}
	// events
	if err := s.InsertEvent(AlertEvent{ID: "e1", RuleID: "r1", InstID: "a", FiredAt: 500, Value: 250, State: "firing"}); err != nil {
		t.Fatalf("InsertEvent: %v", err)
	}
	firing, _ := s.ListEvents("firing", 0, 0)
	if len(firing) != 1 {
		t.Fatalf("expected 1 firing event, got %d", len(firing))
	}
	if err := s.ResolveEvent("r1", 600); err != nil {
		t.Fatalf("ResolveEvent: %v", err)
	}
	firing, _ = s.ListEvents("firing", 0, 0)
	if len(firing) != 0 {
		t.Fatalf("expected 0 firing after resolve, got %d", len(firing))
	}
	// delete rule
	if err := s.DeleteRule("r1"); err != nil {
		t.Fatalf("DeleteRule: %v", err)
	}
	if _, ok, _ := s.GetRule("r1"); ok {
		t.Fatalf("rule should be gone")
	}
}
