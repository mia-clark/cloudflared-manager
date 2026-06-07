# PR-04 internal/process 子进程管家 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** 用 `internal/process` 包替换 `internal/manager/worker.go` 的 frps re-exec 模型：定义 `process.Worker` 通用子进程管家（spawn / 健康判定 / 信号 / 优雅停止 / reap），把 `internal/manager/instance.go` 切到新 Worker，删除 worker.go 和不再需要的 selfExe / Loopback 通路。**过渡态**：默认 spawn 一个 `cloudflared` 命令（**走 PATH 查找**，args=`["tunnel", "--no-autoupdate", "run"]`，无 token、无 TUNNEL_* env）。绝大多数环境会因为找不到二进制或 token 缺失而启动失败，这是预期 —— PR-05 接 binstore 路径解析，PR-08 把 TunnelConfigV1 投影到 Options 后注入 token+env。

**Architecture:** `internal/process.Worker` 持有 `*exec.Cmd` + `done chan` + `mu`，Spawn 启动子进程并把 stdout/stderr 灌到 `io.Writer`（沿用现有 `instanceLog` Writer）；健康判定极简（进程未立刻退出且未在 startup window 内死亡）；Stop 走"SIGTERM → 等 grace → 第二次 SIGTERM → 5s 后 SIGKILL"序列；Reap 是 cmd.Wait() 的唯一所有者。`instance.go` 把 `*worker` 字段类型换成 `*process.Worker`，spawn 调用切换，loopback() 删除。`manager.go` 移除 `selfExePath` / `selfExe()` / `Loopback()`。`internal/metrics/sampler.go` 的 `InstanceSource` 接口降级为 `RunningIDs()` only，fetch 暂时 noop（PR-07 重写）。

**Tech Stack:** std lib only（`os/exec` / `os` / `syscall` / `context` / `sync` / `time` / `bufio` / `io`）。无新依赖。

---

## 文件结构总览

| 路径 | 动作 | 说明 |
|---|---|---|
| `internal/process/worker.go` | **Create** | `Worker` + `SpawnParams` + `Spawn` + `Stop` + `Reap` + `Done` + `PID` + `Cmd` |
| `internal/process/signal_unix.go` | **Create**（搬自 worker_signal_unix.go） | `signalTerminate(*os.Process) error` 用 SIGTERM |
| `internal/process/signal_windows.go` | **Create**（搬自 worker_signal_windows.go） | Windows 用 `os.Process.Kill()`（PR-07 可升级为 GenerateConsoleCtrlEvent） |
| `internal/process/worker_test.go` | **Create** | 用 `go run` / shell 命令构造 mock 子进程，测 Spawn/Stop/Reap |
| `internal/manager/worker.go` | **Delete** | re-exec 模型整体删除 |
| `internal/manager/worker_signal_unix.go` | **Delete**（已搬迁） | |
| `internal/manager/worker_signal_windows.go` | **Delete**（已搬迁） | |
| `internal/manager/worker_test.go` | **Delete** | 与 worker.go 同步删除（PR-04 重写测试在 internal/process） |
| `internal/manager/instance.go` | **Modify** | `w *worker` → `*process.Worker`；spawn 切换；删 `loopback()` 方法 + handshake；Snapshot 加 `BinaryVersion` 字段（暂留空，PR-05 填）+ `PID` |
| `internal/manager/manager.go` | **Modify** | 删 `selfExePath` 字段 + 构造函数对应行；删 `Loopback()` 方法；`newInstance` 调用对应改签名 |
| `internal/metrics/sampler.go` | **Modify** | `InstanceSource` 接口删 `Loopback` 方法，仅留 `RunningIDs`；fetch 临时 noop（不再调 frps mem 端点；PR-07 重写） |
| `internal/metrics/sampler_test.go` | **Modify**（按需） | 适配新接口签名 |

**不动**：cmd/cfdmgrd / pkg/cfdconfig / pkg/cfdflags / pkg/cfdstate / pkg/config（PR-08）/ pkg/version / pkg/util / internal/api / internal/eventbus / internal/logtail / internal/sysinfo / internal/selfupdate / internal/appcfg / services / web / Makefile / Dockerfile / yml / scripts / docs。

---

## Task 1：基线校验

- [ ] **Step 1.1** `git status` working tree clean，分支 `feature/pr01-bootstrap-rename`，HEAD `5ecb334`。

- [ ] **Step 1.2** 基线全绿
```bash
cd /d/Github_Codes_mia-clark/cloudflared-manager
go vet ./... && go test ./... && go build -o /tmp/baseline ./cmd/cfdmgrd && rm -f /tmp/baseline
```
Expected: 全 exit 0。

---

## Task 2：创建 internal/process 包

### Step 2.1 mkdir + 写 `internal/process/worker.go`

```bash
mkdir -p internal/process
```

`internal/process/worker.go` 完整内容：

```go
// Package process supervises a long-running child process — typically
// the cloudflared connector binary — on behalf of a single instance.
//
// Responsibilities split with internal/manager: this package owns the
// os/exec lifecycle (Start, signal, Wait), while internal/manager owns
// the instance state machine (cfdstate.ConfigState transitions, log
// sinks, event bus notifications). The two communicate through a small
// Worker handle and a done channel.
//
// Compared to the previous frps re-exec-self model:
//   * no handshake protocol: the parent is no longer the same binary,
//     so there is no pre-allocated loopback port and no FRPS_WORKER_READY
//     line to parse;
//   * stdout AND stderr are both piped to the caller-provided io.Writer
//     (the per-instance log writer in internal/manager). cloudflared
//     writes its structured logs to stderr by default, but stdout is
//     also captured to forward any banner / fallback output;
//   * health is judged simply by "child process did not die within a
//     startup grace window". The richer three-tier check from spec §3.2
//     (alive + /ready=200 + readyConnections>=1) lands in PR-05/PR-07
//     once cfdbin and the metrics endpoint are wired up.
package process

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"time"
)

// SpawnParams configures a single Worker. Fields are immutable for the
// life of the Worker; reconfiguration means stop + new Spawn.
type SpawnParams struct {
	// BinaryPath is the absolute path of the executable to launch. If
	// empty the spawn fails fast; PR-05's cfdbin.Resolve is what fills
	// this in production.
	BinaryPath string

	// Args is the argv tail passed after BinaryPath. cloudflared callers
	// will typically pass {"tunnel", "--no-autoupdate", "run"} (plus an
	// optional "--label <value>" pair).
	Args []string

	// Env is merged into the parent's os.Environ() at spawn time. Use
	// this to inject TUNNEL_TOKEN / TUNNEL_METRICS / NO_AUTOUPDATE / any
	// TUNNEL_* override. cfdmgrd-mandated values must be appended LAST
	// by the caller so they override any user supplied AdvancedEnvOverrides.
	Env []string

	// LogSink receives both stdout and stderr line-buffered streams.
	// The supervisor never blocks on a slow sink; it relies on the
	// io.Writer's internal buffering / mutex.
	LogSink io.Writer

	// StartupGrace is how long Spawn waits before declaring the child
	// "successfully started". If the child exits during this window
	// Spawn returns an error and the caller sees no Worker. Defaults to
	// 2s when zero so unit tests stay snappy; real spawns should pass
	// ~5s to absorb cloudflared edge-handshake latency.
	StartupGrace time.Duration

	// StopGrace is how long Stop waits between the first SIGTERM and a
	// second SIGTERM (which cloudflared treats as "force shutdown"),
	// then 2s before sending SIGKILL. Zero defaults to 5s.
	StopGrace time.Duration
}

// Worker is the live handle to one supervised child process. Methods
// are safe to call from multiple goroutines.
type Worker struct {
	cmd      *exec.Cmd
	done     chan struct{}
	waitOnce sync.Once

	mu       sync.Mutex
	exitErr  error
	stopGrace time.Duration
}

// ErrNoBinary is returned by Spawn when BinaryPath is empty.
var ErrNoBinary = errors.New("process: BinaryPath is empty")

// ErrChildExitedEarly is returned by Spawn when the child exits during
// the StartupGrace window.
var ErrChildExitedEarly = errors.New("process: child exited within startup grace")

// Spawn launches a child process and returns a Worker that owns its
// lifecycle. On failure the child (if any) is reaped before returning.
//
// Spawn DOES NOT block until the child is "fully ready" — there is no
// upstream definition of "ready" that holds across PR boundaries. The
// caller (internal/manager.instance) is responsible for any further
// health probing (e.g. polling /ready in PR-05+).
func Spawn(ctx context.Context, p SpawnParams) (*Worker, error) {
	if p.BinaryPath == "" {
		return nil, ErrNoBinary
	}
	startupGrace := p.StartupGrace
	if startupGrace == 0 {
		startupGrace = 2 * time.Second
	}
	stopGrace := p.StopGrace
	if stopGrace == 0 {
		stopGrace = 5 * time.Second
	}

	cmd := exec.CommandContext(ctx, p.BinaryPath, p.Args...)
	if len(p.Env) > 0 {
		cmd.Env = p.Env
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("process: stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("process: stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("process: start %s: %w", p.BinaryPath, err)
	}

	w := &Worker{
		cmd:       cmd,
		done:      make(chan struct{}),
		stopGrace: stopGrace,
	}

	// Forward stdout + stderr to the sink. nil sink → discard.
	sink := p.LogSink
	if sink == nil {
		sink = io.Discard
	}
	go func() { _, _ = io.Copy(sink, stdout) }()
	go func() { _, _ = io.Copy(sink, stderr) }()

	// Reaper: sole owner of cmd.Wait(). Close done when child exits.
	go func() {
		err := cmd.Wait()
		w.mu.Lock()
		w.exitErr = err
		w.mu.Unlock()
		close(w.done)
	}()

	// Startup grace: if child dies within this window, treat the spawn
	// as failed and surface the exit error.
	select {
	case <-w.done:
		exitErr := w.ExitErr()
		if exitErr == nil {
			exitErr = ErrChildExitedEarly
		}
		return nil, fmt.Errorf("process: %w: %v", ErrChildExitedEarly, exitErr)
	case <-time.After(startupGrace):
		// passed grace; child is still alive
	}

	return w, nil
}

// PID returns the child's OS process id, or 0 if it has already exited
// and been reaped.
func (w *Worker) PID() int {
	if w.cmd.Process == nil {
		return 0
	}
	return w.cmd.Process.Pid
}

// Cmd exposes the underlying *exec.Cmd for advanced callers (e.g. tests
// inspecting Args/Env). Mutating it after Spawn returns is unsafe.
func (w *Worker) Cmd() *exec.Cmd { return w.cmd }

// Done returns a channel that closes when the child has exited and the
// reaper has called cmd.Wait().
func (w *Worker) Done() <-chan struct{} { return w.done }

// ExitErr returns the child's exit error after Done closes, or nil if
// the child has not yet exited.
func (w *Worker) ExitErr() error {
	select {
	case <-w.done:
		w.mu.Lock()
		defer w.mu.Unlock()
		return w.exitErr
	default:
		return nil
	}
}

// Stop terminates the child gracefully. It sends SIGTERM (or platform
// equivalent), waits up to stopGrace, sends a second SIGTERM (which
// cloudflared interprets as "force"), waits up to 2s, then SIGKILLs as
// a last resort. Returns once the child has been reaped.
func (w *Worker) Stop() error {
	if w.cmd.Process == nil {
		return nil
	}
	_ = signalTerminate(w.cmd.Process)
	select {
	case <-w.done:
		return nil
	case <-time.After(w.stopGrace):
	}
	// Second-shot signal: cloudflared upgrades this to "force shutdown".
	_ = signalTerminate(w.cmd.Process)
	select {
	case <-w.done:
		return nil
	case <-time.After(2 * time.Second):
	}
	_ = w.cmd.Process.Kill()
	<-w.done
	return nil
}
```

### Step 2.2 写 `internal/process/signal_unix.go`

```go
//go:build !windows

package process

import (
	"os"
	"syscall"
)

// signalTerminate sends SIGTERM on POSIX systems. cloudflared handles
// SIGTERM by initiating a graceful shutdown; a second SIGTERM short-
// circuits the in-flight request drain.
func signalTerminate(p *os.Process) error {
	return p.Signal(syscall.SIGTERM)
}
```

### Step 2.3 写 `internal/process/signal_windows.go`

```go
//go:build windows

package process

import "os"

// signalTerminate on Windows falls back to a hard kill. Windows lacks
// POSIX-style signals, and Go's os.Process.Signal accepts only os.Kill
// and os.Interrupt. os.Interrupt only works for processes attached to
// the same console — which our daemon-spawned children are not. A
// richer GenerateConsoleCtrlEvent path with CREATE_NEW_PROCESS_GROUP
// is sketched in spec §3.4; PR-07 may upgrade this when the
// graceful-shutdown story matters more for cloudflared on Windows.
func signalTerminate(p *os.Process) error {
	return p.Kill()
}
```

### Step 2.4 写 `internal/process/worker_test.go`

```go
package process_test

import (
	"bytes"
	"context"
	"errors"
	"runtime"
	"testing"
	"time"

	"github.com/mia-clark/cloudflared-manager/internal/process"
)

// sleepCmd returns the absolute path + args of a small "sleep forever"
// command available on every supported platform. We avoid /bin/sh -c
// because Windows.
func sleepCmd(t *testing.T) (string, []string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		// powershell.exe Start-Sleep is universally present and shuts
		// down on Kill cleanly.
		return "powershell.exe", []string{"-NoLogo", "-NoProfile", "-Command", "Start-Sleep -Seconds 60"}
	}
	return "/bin/sh", []string{"-c", "sleep 60"}
}

func TestSpawn_EmptyBinary(t *testing.T) {
	_, err := process.Spawn(context.Background(), process.SpawnParams{})
	if !errors.Is(err, process.ErrNoBinary) {
		t.Fatalf("expected ErrNoBinary, got %v", err)
	}
}

func TestSpawn_StartAndStop(t *testing.T) {
	bin, args := sleepCmd(t)
	var sink bytes.Buffer
	w, err := process.Spawn(context.Background(), process.SpawnParams{
		BinaryPath:   bin,
		Args:         args,
		LogSink:      &sink,
		StartupGrace: 200 * time.Millisecond,
		StopGrace:    200 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}
	if w.PID() <= 0 {
		t.Errorf("expected positive PID, got %d", w.PID())
	}
	if err := w.Stop(); err != nil {
		t.Errorf("stop: %v", err)
	}
	select {
	case <-w.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("worker did not finish after Stop")
	}
}

func TestSpawn_ChildExitsEarly(t *testing.T) {
	bin := "/bin/sh"
	args := []string{"-c", "exit 7"}
	if runtime.GOOS == "windows" {
		bin = "cmd.exe"
		args = []string{"/c", "exit /b 7"}
	}
	_, err := process.Spawn(context.Background(), process.SpawnParams{
		BinaryPath:   bin,
		Args:         args,
		StartupGrace: 500 * time.Millisecond,
	})
	if !errors.Is(err, process.ErrChildExitedEarly) {
		t.Fatalf("expected ErrChildExitedEarly, got %v", err)
	}
}

func TestSpawn_LogSinkReceivesOutput(t *testing.T) {
	bin := "/bin/sh"
	args := []string{"-c", "echo hello-from-child; sleep 60"}
	if runtime.GOOS == "windows" {
		bin = "powershell.exe"
		args = []string{"-NoLogo", "-NoProfile", "-Command", "Write-Host hello-from-child; Start-Sleep -Seconds 60"}
	}
	var sink bytes.Buffer
	w, err := process.Spawn(context.Background(), process.SpawnParams{
		BinaryPath:   bin,
		Args:         args,
		LogSink:      &sink,
		StartupGrace: 500 * time.Millisecond,
		StopGrace:    200 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}
	// give pipes a moment
	time.Sleep(300 * time.Millisecond)
	if !bytes.Contains(sink.Bytes(), []byte("hello-from-child")) {
		t.Errorf("log sink did not receive expected stdout; got %q", sink.String())
	}
	_ = w.Stop()
}
```

### Step 2.5 vet + test
```bash
go vet ./internal/process/...
go test ./internal/process/... -v 2>&1 | tail -30
```
Expected: vet 0；4 个 test 全 PASS（每个 < 4s）。

---

## Task 3：rewire manager / instance + 删 worker.go

### Step 3.1 用以下完整内容**整体覆盖** `internal/manager/instance.go`

把 frps re-exec / handshake 字段全删，loopback() 方法删，改为持有 `*process.Worker`。Snapshot 加 BinaryVersion 字段（暂留空 / PR-05 填）+ PID。

```go
package manager

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"github.com/mia-clark/cloudflared-manager/internal/eventbus"
	"github.com/mia-clark/cloudflared-manager/internal/process"
	"github.com/mia-clark/cloudflared-manager/pkg/cfdstate"
	"github.com/mia-clark/cloudflared-manager/pkg/util"
)

// instance owns a single cloudflared connector lifecycle. Each running
// instance lives in its own external process supervised by
// internal/process.Worker — there is no longer any re-exec-self magic.
type instance struct {
	id   string
	path string

	mu      sync.RWMutex
	state   cfdstate.ConfigState
	lastErr string
	startAt time.Time
	stopAt  time.Time

	// run-time fields (zero unless running)
	w      *process.Worker
	cancel context.CancelFunc

	logger  *slog.Logger
	bus     *eventbus.Bus
	logSink io.Writer
}

func newInstance(id, path string, logger *slog.Logger, bus *eventbus.Bus, logSink io.Writer) *instance {
	return &instance{
		id:      id,
		path:    path,
		state:   cfdstate.ConfigStateStopped,
		logger:  logger.With(slog.String("config_id", id)),
		bus:     bus,
		logSink: logSink,
	}
}

// ID returns the immutable config id (file stem).
func (i *instance) ID() string { return i.id }

// Path returns the absolute path of the underlying config file.
func (i *instance) Path() string { return i.path }

// Snapshot describes the run-time status of one instance.
type Snapshot struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	Path          string     `json:"path"`     // config 文件路径（PR-08 后为 .yaml）
	LogPath       string     `json:"log_path"`
	State         string     `json:"state"`
	LastError     string     `json:"last_error,omitempty"`
	StartedAt     *time.Time `json:"started_at,omitempty"`
	StoppedAt     *time.Time `json:"stopped_at,omitempty"`
	BinaryVersion string     `json:"binary_version,omitempty"` // 该实例当前使用的 cloudflared 版本，PR-05 起填充
	PID           int        `json:"pid,omitempty"`            // 子进程 pid，0 表示未运行
}

// Snapshot returns a JSON-friendly status view. Name / LogPath are
// injected by the Manager from meta.json + LogsDir respectively.
func (i *instance) Snapshot() Snapshot {
	i.mu.RLock()
	defer i.mu.RUnlock()
	s := Snapshot{
		ID:        i.id,
		Path:      i.path,
		State:     stateString(i.state),
		LastError: i.lastErr,
	}
	if !i.startAt.IsZero() {
		t := i.startAt
		s.StartedAt = &t
	}
	if !i.stopAt.IsZero() {
		t := i.stopAt
		s.StoppedAt = &t
	}
	if i.w != nil {
		s.PID = i.w.PID()
	}
	return s
}

// State returns the current lifecycle state.
func (i *instance) State() cfdstate.ConfigState {
	i.mu.RLock()
	defer i.mu.RUnlock()
	return i.state
}

// setState assigns a new state under lock and returns whether it changed.
func (i *instance) setState(s cfdstate.ConfigState) bool {
	i.mu.Lock()
	prev := i.state
	if i.state == s {
		i.mu.Unlock()
		return false
	}
	i.state = s
	switch s {
	case cfdstate.ConfigStateStarted:
		i.startAt = time.Now()
	case cfdstate.ConfigStateStopped:
		i.stopAt = time.Now()
	}
	i.mu.Unlock()
	if i.bus != nil {
		i.bus.Publish(eventbus.TypeInstanceState, i.id, eventbus.InstanceStateData{
			State:     stateString(s),
			PrevState: stateString(prev),
		})
	}
	return true
}

// start spawns the cloudflared subprocess.
//
// PR-04 transitional behaviour: argv is the minimal ["tunnel",
// "--no-autoupdate", "run"], BinaryPath is "cloudflared" (PATH lookup).
// No token / TUNNEL_* env is set yet — that lands in PR-08 when the
// API layer projects TunnelConfigV1 onto cfdflags.Options. In practice
// this means PR-04 spawns will fail on most hosts (no cloudflared in
// PATH, or no token → cloudflared exits early). That is expected.
func (i *instance) start(ctx context.Context) error {
	i.mu.Lock()
	if i.state == cfdstate.ConfigStateStarted || i.state == cfdstate.ConfigStateStarting {
		i.mu.Unlock()
		return errors.New("already running")
	}
	i.state = cfdstate.ConfigStateStarting
	i.lastErr = ""
	i.mu.Unlock()

	runCtx, cancel := context.WithCancel(ctx)
	w, err := process.Spawn(runCtx, process.SpawnParams{
		BinaryPath:   "cloudflared",
		Args:         []string{"tunnel", "--no-autoupdate", "run"},
		LogSink:      i.logSink,
		StartupGrace: 5 * time.Second,
		StopGrace:    5 * time.Second,
	})
	if err != nil {
		cancel()
		i.recordError(err)
		i.setState(cfdstate.ConfigStateStopped)
		return fmt.Errorf("spawn cloudflared: %w", err)
	}
	i.mu.Lock()
	i.w = w
	i.cancel = cancel
	i.mu.Unlock()

	go func() {
		<-w.Done()
		i.mu.Lock()
		stopping := i.state == cfdstate.ConfigStateStopping
		i.w = nil
		i.cancel = nil
		i.mu.Unlock()
		cancel()
		if !stopping {
			if exitErr := w.ExitErr(); exitErr != nil {
				i.recordError(fmt.Errorf("cloudflared exited: %w", exitErr))
			}
			i.setState(cfdstate.ConfigStateStopped)
			i.logger.Info("cloudflared exited", slog.Int("pid", w.PID()))
		}
	}()

	i.setState(cfdstate.ConfigStateStarted)
	i.logger.Info("cloudflared instance started", slog.Int("pid", w.PID()))
	return nil
}

// stop terminates the child process and waits for it to be reaped.
func (i *instance) stop() error {
	i.mu.Lock()
	if i.state == cfdstate.ConfigStateStopped || i.state == cfdstate.ConfigStateStopping {
		i.mu.Unlock()
		return nil
	}
	i.state = cfdstate.ConfigStateStopping
	cancel := i.cancel
	w := i.w
	i.mu.Unlock()

	if w != nil {
		_ = w.Stop()
	}
	if cancel != nil {
		cancel()
	}
	i.mu.Lock()
	i.w = nil
	i.cancel = nil
	i.mu.Unlock()
	i.setState(cfdstate.ConfigStateStopped)
	i.logger.Info("cloudflared instance stopped")
	return nil
}

// reload = stop + start. cloudflared has no in-place reload for
// per-connector settings; restart is the only correct path.
func (i *instance) reload(ctx context.Context) error {
	if err := i.stop(); err != nil {
		return err
	}
	return i.start(ctx)
}

func (i *instance) recordError(err error) {
	if err == nil {
		return
	}
	i.mu.Lock()
	i.lastErr = err.Error()
	i.mu.Unlock()
	i.logger.Warn("instance error", slog.Any("err", err))
	if i.bus != nil {
		i.bus.Publish(eventbus.TypeInstanceError, i.id, eventbus.InstanceErrorData{Message: err.Error()})
	}
}

// idFromPath derives a config id from a file path (file stem).
func idFromPath(path string) string {
	return util.FileNameWithoutExt(filepath.Base(path))
}

func stateString(s cfdstate.ConfigState) string {
	switch s {
	case cfdstate.ConfigStateStarted:
		return "started"
	case cfdstate.ConfigStateStopped:
		return "stopped"
	case cfdstate.ConfigStateStarting:
		return "starting"
	case cfdstate.ConfigStateStopping:
		return "stopping"
	default:
		return "unknown"
	}
}
```

### Step 3.2 改 `internal/manager/manager.go`

用 Edit 工具替换 4 处：

**Edit 1**：删 `selfExePath` 字段（line 43 附近）：

old:
```go
	meta *metaStore

	selfExePath string

	rootCtx    context.Context
```

new:
```go
	meta *metaStore

	rootCtx    context.Context
```

**Edit 2**：构造函数删 selfExe 调用（line 62-72 附近）：

old:
```go
	meta, err := openMetaStore(opts.MetaPath)
	if err != nil {
		return nil, fmt.Errorf("open meta: %w", err)
	}
	exe, _ := selfExe()
	ctx, cancel := context.WithCancel(context.Background())
	return &Manager{
		opts:        opts,
		instances:   make(map[string]*instance),
		logs:        make(map[string]*instanceLog),
		meta:        meta,
		selfExePath: exe,
		rootCtx:     ctx,
		rootCancel:  cancel,
	}, nil
```

new:
```go
	meta, err := openMetaStore(opts.MetaPath)
	if err != nil {
		return nil, fmt.Errorf("open meta: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Manager{
		opts:       opts,
		instances:  make(map[string]*instance),
		logs:       make(map[string]*instanceLog),
		meta:       meta,
		rootCtx:    ctx,
		rootCancel: cancel,
	}, nil
```

**Edit 3**：register 调用 newInstance 移除 selfExe 参数（line 104-105 附近）：

old:
```go
func (m *Manager) register(id, path string) *instance {
	inst := newInstance(id, path, m.opts.Logger, m.opts.Bus, m.selfExePath, m.logWriter(id))
```

new:
```go
func (m *Manager) register(id, path string) *instance {
	inst := newInstance(id, path, m.opts.Logger, m.opts.Bus, m.logWriter(id))
```

**Edit 4**：删除 `Loopback` 方法（line 422-435 整段）：

old:
```go
// Loopback returns the running worker's frps webServer loopback address and
// credentials (HTTP Basic) for reading runtime metrics. ok=false if the
// instance is not registered or not currently running.
func (m *Manager) Loopback(id string) (addr, user, pass string, ok bool) {
	inst := m.get(id)
	if inst == nil {
		return "", "", "", false
	}
	hs, running := inst.loopback()
	if !running {
		return "", "", "", false
	}
	return hs.Addr, hs.User, hs.Pass, true
}
```

new: （整段删除，不留空函数）

### Step 3.3 删 worker.go 和相关辅助
```bash
git rm internal/manager/worker.go internal/manager/worker_signal_unix.go internal/manager/worker_signal_windows.go internal/manager/worker_test.go
```

### Step 3.4 单包 vet
```bash
go vet ./internal/manager/...
```
Expected: 此时 sampler 仍在调用 Loopback，应**编译失败** —— 这是预期，Step 4 修。

如果 vet 报别的错（不是 sampler 的 Loopback 调用），按错误信息排查。

---

## Task 4：降级 internal/metrics/sampler.go 接口

### Step 4.1 看 sampler.go 当前接口
```bash
grep -nE 'InstanceSource|Loopback|RunningIDs' internal/metrics/sampler.go
```

### Step 4.2 改 `internal/metrics/sampler.go`

用 Edit 工具：

**Edit 1**：`InstanceSource` 接口删 Loopback 方法。原文（line 19-22 附近）：

old:
```go
type InstanceSource interface {
	RunningIDs() []string
	Loopback(id string) (addr, user, pass string, ok bool)
}
```

new:
```go
type InstanceSource interface {
	RunningIDs() []string
	// MetricsAddr is reserved for PR-07: it will return the per-instance
	// cloudflared --metrics 127.0.0.1:<port> address. PR-04 leaves it
	// out; sampler.fetch is a no-op until PR-07 rewrites it.
}
```

**Edit 2**：找到 fetch / sample 函数中实际调用 `Loopback(id)` 的位置（grep 已定位），把整个 fetch 主体临时改为 noop。原文（line 156-194 附近）大致为遍历 RunningIDs 调用 Loopback 然后访问 frps 的 mem 接口；把整个 fetch 内部循环替换为：

old（大致结构，按实际位置定位）：
```go
func (s *Sampler) fetch(...) ... {
	for _, id := range s.src.RunningIDs() {
		addr, user, pass, ok := s.src.Loopback(id)
		if !ok {
			continue
		}
		// ... 拉 frps mem API ...
	}
	// ... 评估告警 ...
}
```

new（删 Loopback 调用 + noop fetch 内部循环）：
```go
func (s *Sampler) fetch(...) ... {
	// PR-04 transition: sampler is intentionally a no-op. The previous
	// frps mem-endpoint poller has been removed along with the re-exec
	// worker model; the new cloudflared metrics poller lands in PR-07,
	// which will scrape per-instance 127.0.0.1:<port>/metrics endpoints
	// and feed the same SQLite series + alert evaluator below.
	_ = s.src.RunningIDs()
	// 保留下面的告警评估调用：当没有新样本时它什么都不做，但仍然推进
	// firing/resolved 状态机的去抖窗口逻辑。
	// ... 原有 evalRules / publish 等保留 ...
}
```

> 关键准则：**保留**所有不涉及 frps mem 拉取的代码（store / alerts / rule evaluator / event publish）。**只切掉** Loopback 调用与紧随其后的 HTTP 拉取 / 数据点入库部分。如果分不清边界，把整个 fetch 函数体改成最小留存：
> ```go
> func (s *Sampler) fetch(...) {
>     _ = s.src.RunningIDs()
> }
> ```
> 这是过渡态可接受的，因为没有告警数据写入意味着告警不触发，但 daemon 不崩。

如果 sampler.go 复杂度高、Edit 边界不清晰，**改用整体 Read + 重写**策略，把 fetch / sample 内部主体改为 noop 占位。

### Step 4.3 全量 vet + test + build
```bash
go vet ./...
go test ./... 2>&1 | tail -15
go build -o bin/cfdmgrd ./cmd/cfdmgrd && ./bin/cfdmgrd version
```
Expected: 全 exit 0；测试可能有少数因接口签名变化失败的 `internal/metrics/sampler_test.go` 等，逐个处理。

---

## Task 5：测试适配

### Step 5.1 跑测试看失败清单
```bash
go test ./... -count=1 2>&1 | grep -E '(FAIL|undefined|cannot use)' | head -20
```

### Step 5.2 修复失败测试
- `internal/manager/manager_test.go`：可能依赖 selfExe / Loopback，按需删/改对应测试用例
- `internal/metrics/sampler_test.go`：接口 mock 删除 Loopback 方法
- `internal/manager/instance_test.go`（如有）：构造函数签名变了

逐个文件 Read + Edit，让测试编译通过。
不必让删掉的能力（frps mem 拉取）的测试继续 PASS — 这些测试应当被**删除**或**用 t.Skip("PR-07 will rewrite this")** 占位。

### Step 5.3 全量绿
```bash
go vet ./... && go test ./... && go build -o bin/cfdmgrd ./cmd/cfdmgrd && ./bin/cfdmgrd version
```
Expected: 全绿。

### Step 5.4 daemon smoke
```bash
rm -rf ./tmp/data; mkdir -p ./tmp/data
CFDM_API_TOKEN=dev CFDM_DATA_DIR=./tmp/data ./bin/cfdmgrd serve > /tmp/cfdmgrd-pr04.log 2>&1 &
SERVE_PID=$!
sleep 2
curl -fsS http://127.0.0.1:8080/api/v1/health
echo
curl -fsS -H "Authorization: Bearer dev" http://127.0.0.1:8080/api/v1/configs
echo
kill $SERVE_PID 2>/dev/null
sleep 1
rm -rf ./tmp/data /tmp/cfdmgrd-pr04.log
```
Expected: `/health` 200，`/configs` 返回 `{"items":[]}` 或 `[]`。

---

## Task 6：commit（controller 主线）

由 controller 处理。

---

## Self-Review

✅ **Spec 覆盖**：
- internal/process 新增 → Task 2 / spec §1.2 + §3
- internal/manager/worker.go 删除 → Task 3.3
- instance.go 重写持有 *process.Worker → Task 3.1
- manager.go 移除 selfExe + Loopback → Task 3.2
- Snapshot 加 BinaryVersion / PID 字段 → Task 3.1
- sampler 降级 → Task 4（spec §10.1.5 metrics.sampler REPLACE 的过渡步骤）

✅ **类型一致性**：
- `process.Worker` 公开方法集（Spawn/Stop/Done/ExitErr/PID/Cmd）与 instance.go 调用点一一对应
- `Snapshot.PID int` 与 spec §2 一致
- 信号封装跨平台一致（signal_unix.go / signal_windows.go 双文件 build tag）

✅ **依赖方向**：
- internal/process 仅 std lib
- internal/manager 新增依赖 internal/process（合法：manager 高于 process）
- internal/metrics/sampler 不再依赖 manager.Loopback

✅ **过渡态清晰**：
- spec §3 推荐的"健康判定三层组合"在 PR-04 简化为"未在 startup grace 内死亡"，PR-05/07 升级
- token / TUNNEL_* env 注入留给 PR-08
- binary path 硬编码 "cloudflared" 留给 PR-05 接 binstore
- sampler 退化为 noop 留给 PR-07 重写

---

## Execution Handoff

2 batch：Batch I（Task 1-2 创建 internal/process）；Batch II（Task 3-5 rewire + 测试适配）；Task 6 commit 由 controller。
