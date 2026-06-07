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
		// Write-Host goes to the PowerShell host (not stdout) and comes out as
		// UTF-16 LE; use cmd.exe echo which writes plain ASCII bytes to stdout.
		bin = "cmd.exe"
		args = []string{"/c", "echo hello-from-child & powershell.exe -NoLogo -NoProfile -Command Start-Sleep -Seconds 60"}
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
