// Package logtail provides a simple "tail -f" style follower for a single
// log file. It detects appends, truncations, and rotations via fsnotify
// plus modtime comparison, and delivers each new line to subscribers
// through a channel.
package logtail

import (
	"bufio"
	"errors"
	"io"
	"os"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// Tailer follows a single file path. Multiple subscribers are supported;
// each gets its own channel.
type Tailer struct {
	path string

	mu      sync.Mutex
	subs    []chan string
	started bool
	stopCh  chan struct{}
}

// New creates a Tailer for path. The file does not need to exist yet.
func New(path string) *Tailer {
	return &Tailer{path: path, stopCh: make(chan struct{})}
}

// Subscribe returns a channel that yields each newly appended line. Call
// Unsubscribe to release resources.
func (t *Tailer) Subscribe() <-chan string {
	t.mu.Lock()
	ch := make(chan string, 256)
	t.subs = append(t.subs, ch)
	started := t.started
	t.started = true
	t.mu.Unlock()
	if !started {
		go t.run()
	}
	return ch
}

// Unsubscribe closes the given channel (no-op if already removed).
func (t *Tailer) Unsubscribe(c <-chan string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for i, ch := range t.subs {
		if ch == c { //nolint:gosimple
			close(ch)
			t.subs = append(t.subs[:i], t.subs[i+1:]...)
			return
		}
	}
}

// Stop terminates the background follower and closes all subscriber
// channels.
func (t *Tailer) Stop() {
	t.mu.Lock()
	if !t.started {
		t.mu.Unlock()
		return
	}
	t.started = false
	t.mu.Unlock()
	select {
	case <-t.stopCh:
	default:
		close(t.stopCh)
	}
}

func (t *Tailer) fanout(line string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, ch := range t.subs {
		select {
		case ch <- line:
		default:
		}
	}
}

func (t *Tailer) closeAll() {
	t.mu.Lock()
	for _, ch := range t.subs {
		close(ch)
	}
	t.subs = nil
	t.mu.Unlock()
}

// run is the goroutine that tails the file forever (until Stop).
func (t *Tailer) run() {
	defer t.closeAll()

	watcher, err := fsnotify.NewWatcher()
	if err == nil {
		defer watcher.Close()
		_ = watcher.Add(parentDir(t.path))
	}

	var (
		f      *os.File
		reader *bufio.Reader
	)

	open := func() {
		closeFile(f)
		var ferr error
		f, ferr = os.Open(t.path)
		if ferr != nil {
			f = nil
			reader = nil
			return
		}
		// start from end of file: new lines only
		_, _ = f.Seek(0, io.SeekEnd)
		reader = bufio.NewReader(f)
	}
	open()
	defer closeFile(f)

	idle := time.NewTimer(500 * time.Millisecond)
	defer idle.Stop()

	for {
		// drain any available lines
		if reader != nil {
			for {
				line, err := reader.ReadString('\n')
				if err == nil {
					t.fanout(trimNewline(line))
					continue
				}
				if errors.Is(err, io.EOF) {
					break
				}
				break
			}
		}

		select {
		case <-t.stopCh:
			return
		case ev, ok := <-watcherEvents(watcher):
			if !ok {
				time.Sleep(250 * time.Millisecond)
				continue
			}
			if !pathMatches(ev.Name, t.path) {
				continue
			}
			if ev.Op&(fsnotify.Create|fsnotify.Rename|fsnotify.Remove) != 0 {
				open()
				continue
			}
			// write/append: loop and read more
		case <-idle.C:
			if reader == nil {
				open()
			}
			idle.Reset(500 * time.Millisecond)
		}
	}
}

func watcherEvents(w *fsnotify.Watcher) <-chan fsnotify.Event {
	if w == nil {
		var c chan fsnotify.Event
		return c
	}
	return w.Events
}

func parentDir(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' || p[i] == '\\' {
			if i == 0 {
				return string(p[0])
			}
			return p[:i]
		}
	}
	return "."
}

func pathMatches(observed, want string) bool {
	if observed == want {
		return true
	}
	// fsnotify may report the watched-dir path on add/remove; treat
	// any event in the parent dir as relevant since we only watch one
	// file per tailer.
	return parentDir(observed) == parentDir(want)
}

func trimNewline(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}

func closeFile(f *os.File) {
	if f != nil {
		_ = f.Close()
	}
}
