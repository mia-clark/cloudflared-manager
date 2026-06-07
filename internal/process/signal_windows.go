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
