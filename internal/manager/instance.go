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
	Path          string     `json:"path"` // config 文件路径（PR-08 后为 .yaml）
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
