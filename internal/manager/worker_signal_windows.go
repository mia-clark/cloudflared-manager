//go:build windows

package manager

import "os"

// Windows 无 SIGTERM 投递能力；直接 Kill，由 OS 回收监听端口。
// frps 子进程被硬杀，P1 不追求 Windows 下的优雅 Close（端口仍会释放）。
func signalTerminate(p *os.Process) error { return p.Kill() }
