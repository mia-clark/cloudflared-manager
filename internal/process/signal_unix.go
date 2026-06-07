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
