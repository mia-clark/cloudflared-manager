//go:build !windows

package manager

import (
	"os"
	"syscall"
)

// signalTerminate 在类 Unix 上发送 SIGTERM，让 worker 优雅取消 ctx 并 Close frps。
func signalTerminate(p *os.Process) error { return p.Signal(syscall.SIGTERM) }
