# PR-06 internal/logtail/process_tailer 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** 新增 `internal/logtail/ProcessTailer`：从 cloudflared 子进程的 stdout + stderr io.Reader 接入，**JSON 优先 + raw 兜底**地解析每一行，落入内存环形缓冲（默认 8000），按 Filter 推送给订阅者。**不接入 manager / instance**（PR-08 时 manager 实例化 ProcessTailer 并接到 `process.SpawnParams.LogSink`）。**不引入 lumberjack 磁盘滚动**（spec §6.4，留 PR-08 manager 集成阶段加）。

**Architecture:** `ProcessTailer` 与现有 `Tailer` 并列；前者面向"进程 stdout/stderr"，后者面向"已落盘文件"。两者共享思路（多订阅者 + 容量限流 + 自动关闭）但**不共享代码**（处理流不同）。

**Tech Stack:** std lib only（`bufio` / `encoding/json` / `io` / `os` / `sync` / `time`）。无新依赖。

---

## 文件结构

| 路径 | 动作 | 说明 |
|---|---|---|
| `internal/logtail/process_tailer.go` | **Create** | `ProcessTailer` + `Entry` + `Filter` + `LogLevel` 数值化 + 6 个公开方法 |
| `internal/logtail/process_tailer_test.go` | **Create** | JSON 解析 / raw 兜底 / ring / filter / subscribe / OnExit 共 8 测试 |

不动：现有 tailer.go + 其它任何文件。

---

## Task 1：基线
```bash
cd /d/Github_Codes_mia-clark/cloudflared-manager
git status
go vet ./... && go test ./... && go build -o /tmp/x ./cmd/cfdmgrd && rm -f /tmp/x
```
Expected: working tree clean，全绿。

---

## Task 2：写 `internal/logtail/process_tailer.go`

完整内容：

```go
package logtail

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ProcessTailer captures stdout + stderr from a single child process,
// parses each line as cloudflared's --output=json structured log when
// possible, and fans the resulting Entry stream out to subscribers.
//
// Unlike the file-oriented Tailer in this package, ProcessTailer
// terminates on its own when both pipes hit EOF — there is no "follow
// forever" semantic because a process exits and its output ends.
type ProcessTailer struct {
	instanceID string
	ringSize   int

	mu   sync.Mutex
	ring []Entry
	head int // next write index when ring is full
	full bool

	subs []*subscriber

	seq atomic.Uint64

	stopped atomic.Bool
}

// Entry is one structured log line as surfaced to subscribers and HTTP
// callers. Fields originally absent from cloudflared's JSON output stay
// at their zero value.
type Entry struct {
	Seq       uint64         `json:"seq"`
	Time      time.Time      `json:"time"`
	Level     string         `json:"level"`             // info|warn|error|fatal|debug|unknown
	Message   string         `json:"message"`
	Event     int            `json:"event,omitempty"`
	ConnIndex *int           `json:"conn_index,omitempty"`
	TunnelID  string         `json:"tunnel_id,omitempty"`
	Raw       string         `json:"raw"`
	Fields    map[string]any `json:"fields,omitempty"`
	Source    string         `json:"source"` // "stderr" | "stdout" | "daemon"
}

// Filter trims the stream pushed to a subscriber. A zero Filter
// accepts everything.
type Filter struct {
	MinLevel  string    // "debug" / "info" / "warn" / "error" / "fatal" — empty = accept all
	Keyword   string    // substring match on Message + Raw (case-insensitive)
	Events    []int     // any-of match; empty = accept all
	ConnIndex *int      // exact match; nil = accept all
	Since     time.Time // accept entries strictly newer; zero = accept all
}

type subscriber struct {
	ch     chan Entry
	filter Filter
}

// New creates a ProcessTailer for a single instance. ringSize defaults
// to 8000 when 0; callers may pass smaller values for memory-sensitive
// scenarios (spec §6.4: CFDM_LOG_RING_SIZE knob).
func New(instanceID string, ringSize int) *ProcessTailer {
	if ringSize <= 0 {
		ringSize = 8000
	}
	return &ProcessTailer{
		instanceID: instanceID,
		ringSize:   ringSize,
		ring:       make([]Entry, 0, ringSize),
	}
}

// Attach starts two goroutines that drain stdout and stderr line by
// line. Calling Attach more than once is a no-op after Stop has been
// called; otherwise additional Attaches add more sources to the same
// fanout (rare but supported).
func (p *ProcessTailer) Attach(stdout, stderr io.Reader) {
	if p.stopped.Load() {
		return
	}
	if stdout != nil {
		go p.pump(stdout, "stdout")
	}
	if stderr != nil {
		go p.pump(stderr, "stderr")
	}
}

// pump reads source line by line and forwards each as an Entry.
// bufio.Scanner is configured with a 1 MiB ceiling so cloudflared
// debug-mode header dumps (8–32 KiB lines) do not trigger ErrTooLong.
func (p *ProcessTailer) pump(r io.Reader, source string) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		if p.stopped.Load() {
			return
		}
		raw := sc.Text()
		p.append(parseLine(raw, source))
	}
}

// parseLine converts one raw text line into a structured Entry.
// JSON-first, raw fallback: malformed JSON or non-JSON text becomes an
// Entry with Level="unknown" and Message=Raw=raw.
func parseLine(raw, source string) Entry {
	e := Entry{
		Source: source,
		Raw:    raw,
		Time:   time.Now().UTC(),
		Level:  "unknown",
		Message: raw,
	}

	trim := strings.TrimSpace(raw)
	if len(trim) == 0 || trim[0] != '{' {
		return e
	}

	var m map[string]any
	if err := json.Unmarshal([]byte(trim), &m); err != nil {
		return e
	}

	// At this point JSON parsed successfully; extract well-known fields
	// and tuck the remainder into Fields for the UI's "expand JSON".
	if v, ok := m["level"].(string); ok {
		e.Level = normaliseLevel(v)
	} else {
		e.Level = "info" // JSON without an explicit level → info
	}
	if v, ok := m["time"].(string); ok {
		if t, err := time.Parse(time.RFC3339Nano, v); err == nil {
			e.Time = t.UTC()
		}
	}
	if v, ok := m["message"].(string); ok {
		e.Message = v
	}
	if v, ok := m["event"].(float64); ok {
		e.Event = int(v)
	}
	if v, ok := m["connIndex"].(float64); ok {
		ci := int(v)
		e.ConnIndex = &ci
	}
	if v, ok := m["tunnelID"].(string); ok {
		e.TunnelID = v
	}
	// Stash the full decoded map so consumers can inspect any field
	// cloudflared adds in a future version without parser changes.
	e.Fields = m

	return e
}

// normaliseLevel maps cloudflared's historical level vocabulary into
// the canonical set used by Filter.MinLevel.
func normaliseLevel(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	switch s {
	case "warn", "warning":
		return "warn"
	case "err", "error":
		return "error"
	case "fatal", "panic":
		return "fatal"
	case "debug", "trace":
		return "debug"
	case "info":
		return "info"
	default:
		return "unknown"
	}
}

// append assigns the next Seq, inserts the Entry into the ring, and
// fans out to subscribers whose filter matches.
func (p *ProcessTailer) append(e Entry) {
	e.Seq = p.seq.Add(1)
	p.mu.Lock()
	if len(p.ring) < p.ringSize {
		p.ring = append(p.ring, e)
	} else {
		p.ring[p.head] = e
		p.head = (p.head + 1) % p.ringSize
		p.full = true
	}
	subs := append([]*subscriber(nil), p.subs...)
	p.mu.Unlock()

	for _, s := range subs {
		if !match(e, s.filter) {
			continue
		}
		select {
		case s.ch <- e:
		default: // subscriber slow → drop oldest in their channel
			select {
			case <-s.ch:
			default:
			}
			select {
			case s.ch <- e:
			default:
			}
		}
	}
}

// match reports whether e survives filter.
func match(e Entry, f Filter) bool {
	if f.MinLevel != "" && levelRank(e.Level) < levelRank(f.MinLevel) {
		return false
	}
	if f.Keyword != "" {
		needle := strings.ToLower(f.Keyword)
		if !strings.Contains(strings.ToLower(e.Message), needle) && !strings.Contains(strings.ToLower(e.Raw), needle) {
			return false
		}
	}
	if len(f.Events) > 0 {
		hit := false
		for _, ev := range f.Events {
			if e.Event == ev {
				hit = true
				break
			}
		}
		if !hit {
			return false
		}
	}
	if f.ConnIndex != nil {
		if e.ConnIndex == nil || *e.ConnIndex != *f.ConnIndex {
			return false
		}
	}
	if !f.Since.IsZero() && !e.Time.After(f.Since) {
		return false
	}
	return true
}

// levelRank maps a textual level into an integer for >= comparison.
// Unknown levels rank lowest so they never satisfy a MinLevel filter
// (they still show up when no filter is set).
func levelRank(s string) int {
	switch strings.ToLower(s) {
	case "debug":
		return 1
	case "info":
		return 2
	case "warn":
		return 3
	case "error":
		return 4
	case "fatal":
		return 5
	}
	return 0
}

// Subscribe registers a new subscriber and returns (ch, unsubscribe).
// The channel is buffered to 4096 entries; on overflow ProcessTailer
// drops the oldest to make room for the new (never blocks the pump).
func (p *ProcessTailer) Subscribe(f Filter) (<-chan Entry, func()) {
	s := &subscriber{ch: make(chan Entry, 4096), filter: f}
	p.mu.Lock()
	p.subs = append(p.subs, s)
	p.mu.Unlock()
	return s.ch, func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		for i, x := range p.subs {
			if x == s {
				p.subs = append(p.subs[:i], p.subs[i+1:]...)
				close(s.ch)
				return
			}
		}
	}
}

// Snapshot returns up to limit Entries from the ring that survive f.
// Entries are returned oldest-first (insertion order). limit<=0 means
// "no cap".
func (p *ProcessTailer) Snapshot(f Filter, limit int) []Entry {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.ring) == 0 {
		return nil
	}
	// Re-linearise the ring: if not full, p.ring is already in order;
	// if full, the oldest entry sits at p.head.
	out := make([]Entry, 0, len(p.ring))
	if !p.full {
		out = append(out, p.ring...)
	} else {
		out = append(out, p.ring[p.head:]...)
		out = append(out, p.ring[:p.head]...)
	}
	if f != (Filter{}) {
		filtered := out[:0]
		for _, e := range out {
			if match(e, f) {
				filtered = append(filtered, e)
			}
		}
		out = filtered
	}
	if limit > 0 && len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out
}

// OnExit injects a synthetic Entry describing how the child exited.
// Sourced as "daemon" so UI can render it with a distinct marker.
func (p *ProcessTailer) OnExit(state *os.ProcessState) {
	if p.stopped.Load() {
		return
	}
	msg := "cloudflared exited"
	if state != nil {
		msg = "cloudflared exited code=" + itoa(state.ExitCode())
	}
	p.append(Entry{
		Source:  "daemon",
		Level:   "info",
		Message: msg,
		Raw:     msg,
		Time:    time.Now().UTC(),
	})
}

// Stop marks the tailer dead. Subsequent Attach calls are no-ops and
// pump goroutines exit at their next line boundary.
func (p *ProcessTailer) Stop() {
	if !p.stopped.CompareAndSwap(false, true) {
		return
	}
	p.mu.Lock()
	for _, s := range p.subs {
		close(s.ch)
	}
	p.subs = nil
	p.mu.Unlock()
}

// itoa avoids strconv.Itoa to keep the import set minimal; it handles
// the small int range OnExit produces (exit codes).
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
```

---

## Task 3：写 `internal/logtail/process_tailer_test.go`

```go
package logtail_test

import (
	"strings"
	"testing"
	"time"

	"github.com/mia-clark/cloudflared-manager/internal/logtail"
)

func TestParse_JSON_HappyPath(t *testing.T) {
	p := logtail.New("inst-1", 100)
	defer p.Stop()
	r := strings.NewReader(`{"level":"info","time":"2026-06-07T10:00:00Z","message":"hello","event":42,"connIndex":2}` + "\n")
	p.Attach(nil, r)
	time.Sleep(50 * time.Millisecond)
	got := p.Snapshot(logtail.Filter{}, 0)
	if len(got) != 1 {
		t.Fatalf("len=%d want 1", len(got))
	}
	e := got[0]
	if e.Level != "info" || e.Message != "hello" || e.Event != 42 {
		t.Errorf("unexpected entry: %+v", e)
	}
	if e.ConnIndex == nil || *e.ConnIndex != 2 {
		t.Errorf("conn_index: %v", e.ConnIndex)
	}
	if e.Source != "stderr" {
		t.Errorf("source=%q", e.Source)
	}
}

func TestParse_RawFallback_NonJSON(t *testing.T) {
	p := logtail.New("inst-1", 100)
	defer p.Stop()
	p.Attach(strings.NewReader("not a json line\n"), nil)
	time.Sleep(50 * time.Millisecond)
	got := p.Snapshot(logtail.Filter{}, 0)
	if len(got) != 1 {
		t.Fatalf("len=%d want 1", len(got))
	}
	e := got[0]
	if e.Level != "unknown" {
		t.Errorf("level=%q want unknown", e.Level)
	}
	if e.Message != "not a json line" || e.Raw != "not a json line" {
		t.Errorf("entry=%+v", e)
	}
}

func TestParse_RawFallback_MalformedJSON(t *testing.T) {
	p := logtail.New("inst-1", 100)
	defer p.Stop()
	p.Attach(strings.NewReader(`{"level":"info"`+"\n"), nil)
	time.Sleep(50 * time.Millisecond)
	got := p.Snapshot(logtail.Filter{}, 0)
	if len(got) != 1 || got[0].Level != "unknown" {
		t.Errorf("entry=%+v", got)
	}
}

func TestNormaliseLevel_Warning(t *testing.T) {
	p := logtail.New("inst-1", 100)
	defer p.Stop()
	p.Attach(nil, strings.NewReader(`{"level":"warning","message":"old style"}`+"\n"))
	time.Sleep(50 * time.Millisecond)
	got := p.Snapshot(logtail.Filter{}, 0)
	if len(got) != 1 || got[0].Level != "warn" {
		t.Errorf("normalise warning→warn failed: %+v", got)
	}
}

func TestRing_OverwriteOldest(t *testing.T) {
	p := logtail.New("inst-1", 3)
	defer p.Stop()
	// feed 5 lines into a ring of 3
	var b strings.Builder
	for i := 0; i < 5; i++ {
		b.WriteString(`{"message":"m`)
		b.WriteByte(byte('0' + i))
		b.WriteString(`"}` + "\n")
	}
	p.Attach(strings.NewReader(b.String()), nil)
	time.Sleep(80 * time.Millisecond)
	got := p.Snapshot(logtail.Filter{}, 0)
	if len(got) != 3 {
		t.Fatalf("len=%d want 3", len(got))
	}
	if got[0].Message != "m2" || got[2].Message != "m4" {
		t.Errorf("ring order wrong: %+v", got)
	}
}

func TestFilter_MinLevel(t *testing.T) {
	p := logtail.New("inst-1", 100)
	defer p.Stop()
	p.Attach(nil, strings.NewReader(
		`{"level":"debug","message":"d"}`+"\n"+
			`{"level":"info","message":"i"}`+"\n"+
			`{"level":"warn","message":"w"}`+"\n"+
			`{"level":"error","message":"e"}`+"\n",
	))
	time.Sleep(50 * time.Millisecond)
	got := p.Snapshot(logtail.Filter{MinLevel: "warn"}, 0)
	if len(got) != 2 {
		t.Fatalf("len=%d want 2", len(got))
	}
	if got[0].Level != "warn" || got[1].Level != "error" {
		t.Errorf("got=%+v", got)
	}
}

func TestFilter_Keyword(t *testing.T) {
	p := logtail.New("inst-1", 100)
	defer p.Stop()
	p.Attach(nil, strings.NewReader(
		`{"message":"connect attempt"}`+"\n"+
			`{"message":"disconnected"}`+"\n"+
			`{"message":"heartbeat"}`+"\n",
	))
	time.Sleep(50 * time.Millisecond)
	got := p.Snapshot(logtail.Filter{Keyword: "connect"}, 0)
	if len(got) != 2 {
		t.Fatalf("len=%d want 2 (connect attempt + disconnected)", len(got))
	}
}

func TestSubscribe_Live(t *testing.T) {
	p := logtail.New("inst-1", 100)
	defer p.Stop()
	ch, unsub := p.Subscribe(logtail.Filter{})
	defer unsub()
	pr, pw := io.Pipe()
	p.Attach(pr, nil)
	go func() {
		_, _ = pw.Write([]byte(`{"level":"info","message":"live"}` + "\n"))
		_ = pw.Close()
	}()
	select {
	case e := <-ch:
		if e.Message != "live" {
			t.Errorf("entry=%+v", e)
		}
	case <-time.After(time.Second):
		t.Fatal("subscriber did not receive entry in 1s")
	}
}

func TestOnExit(t *testing.T) {
	p := logtail.New("inst-1", 100)
	defer p.Stop()
	p.OnExit(nil) // nil state → no exit code suffix
	got := p.Snapshot(logtail.Filter{}, 0)
	if len(got) != 1 || got[0].Source != "daemon" || got[0].Level != "info" {
		t.Errorf("expected daemon entry, got %+v", got)
	}
}
```

注：测试需要 `io.Pipe`，加 import `"io"`。

---

## Task 4：跑测试 + vet + 全量回归
```bash
go vet ./internal/logtail/...
go test ./internal/logtail/... -v -count=1 -timeout 30s 2>&1 | tail -30
go vet ./...
go test ./... 2>&1 | tail -10
go build -o /tmp/x ./cmd/cfdmgrd && rm -f /tmp/x && echo build_ok
```
Expected: vet 0；9 tests PASS（8 + Subscribe）；全量 vet/test/build 全绿。

---

## Task 5：commit（controller）

---

## Self-Review

✅ spec §6.2 ProcessTailer 接口实现：New / Attach / Subscribe / Snapshot / OnExit / Stop / Entry / Filter
✅ JSON 双轨：JSON 优先 + raw 兜底；malformed JSON 降级 unknown
✅ 容量限流：ring 默认 8000；订阅者满则丢最旧（无 pump 反压）
✅ 等级映射 warn / warning 兼容
⏸ spec §6.4 磁盘 JSONL 滚动（lumberjack）：留 PR-08 manager 接入时引入依赖
⏸ spec §6.5 HTTP API + WS：PR-08 实现
⏸ 接入 manager / instance：PR-08

---

## Execution Handoff

单 batch（Task 1-4），Task 5 commit 由 controller。
