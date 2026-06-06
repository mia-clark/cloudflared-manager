package manager

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// handshakeTimeout 是父进程等待 worker 子进程握手的上限。
const handshakeTimeout = 10 * time.Second

// handshake 是 worker 子进程握手行的解析结果。
type handshake struct {
	Addr string // 127.0.0.1:<port>
	User string
	Pass string
}

// parseHandshake 解析 "FRPS_WORKER_READY addr=.. user=.. pass=.." 一行。
// 非该前缀的行（含 frps 自身日志）一律拒绝。
func parseHandshake(line string) (handshake, bool) {
	line = strings.TrimSpace(line)
	const prefix = "FRPS_WORKER_READY "
	if !strings.HasPrefix(line, prefix) {
		return handshake{}, false
	}
	hs := handshake{}
	for _, kv := range strings.Fields(strings.TrimPrefix(line, prefix)) {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		switch k {
		case "addr":
			hs.Addr = v
		case "user":
			hs.User = v
		case "pass":
			hs.Pass = v
		}
	}
	if hs.Addr == "" {
		return handshake{}, false
	}
	return hs, true
}

// worker 监管一个 frps 子进程。
//
// cmd.Wait() 只能被调用一次，且不能并发调用。这里规定唯一所有者：reap()，
// 由 instance 的退出守护 goroutine 调用恰好一次，完成后关闭 done。stop() 不
// 自己调 Wait，而是发终止信号后等待 done——彻底避免并发 Wait 的未定义行为。
type worker struct {
	id       string
	cmd      *exec.Cmd
	hs       handshake
	done     chan struct{}
	waitOnce sync.Once
}

// reap 调用 cmd.Wait() 恰好一次并关闭 done。是 cmd.Wait() 的唯一所有者。
func (w *worker) reap() {
	w.waitOnce.Do(func() {
		_ = w.cmd.Wait()
		close(w.done)
	})
}

// freeLoopbackPort 预分配一个空闲 loopback 端口（立即释放，交给 worker 绑定）。
// 必须非零：frps 在 WebServer.Port==0 时根本不起 webServer（见计划 R1）。
func freeLoopbackPort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// spawnWorker re-exec 当前二进制为 frps-worker，等待握手就绪。
//
// frps 把自身运行日志打到 stdout（实测，见计划 R9），握手行 FRPS_WORKER_READY
// 并非首行。故这里**逐行扫描** stdout：非握手行转发给 logSink，匹配到握手行后
// 上报并把剩余 stdout 全量转发给 logSink。stderr 直接接到 logSink。
func spawnWorker(ctx context.Context, id, selfExePath, cfgPath string, logSink io.Writer) (*worker, error) {
	port, err := freeLoopbackPort()
	if err != nil {
		return nil, fmt.Errorf("alloc loopback port: %w", err)
	}
	cmd := exec.CommandContext(ctx, selfExePath,
		"frps-worker", "--config", cfgPath, "--webport", fmt.Sprintf("%d", port))
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = logSink
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start worker: %w", err)
	}

	w := &worker{id: id, cmd: cmd, done: make(chan struct{})}
	hsCh := make(chan handshake, 1)
	go func() {
		br := bufio.NewReader(stdout)
		for {
			line, rerr := br.ReadString('\n')
			if line != "" {
				if hs, ok := parseHandshake(line); ok {
					hsCh <- hs
					// 握手之后的所有 stdout 行都是 frps 日志，转发给日志槽。
					_, _ = io.Copy(logSink, br)
					return
				}
				// 握手前的 frps 日志行，照样转发。
				_, _ = io.WriteString(logSink, line)
			}
			if rerr != nil {
				close(hsCh) // EOF/错误前未等到握手
				return
			}
		}
	}()

	select {
	case hs, ok := <-hsCh:
		if !ok {
			// 握手失败路径：尚无 reaper goroutine，这里自行 Wait 回收。
			_ = w.cmd.Process.Kill()
			w.reap()
			return nil, errors.New("worker exited before handshake")
		}
		w.hs = hs
		return w, nil
	case <-time.After(handshakeTimeout):
		_ = w.cmd.Process.Kill()
		w.reap()
		return nil, errors.New("worker handshake timeout")
	}
}

// stop 终止子进程：先发平台终止信号（Unix SIGTERM / Windows Kill），再等待
// reaper（instance 的退出守护 goroutine）完成 cmd.Wait()。stop 自身不调 Wait，
// 故不会与 reaper 并发。若 5s 内未退出则硬杀兜底。
func (w *worker) stop() error {
	if w.cmd.Process != nil {
		_ = signalTerminate(w.cmd.Process)
	}
	select {
	case <-w.done:
	case <-time.After(5 * time.Second):
		if w.cmd.Process != nil {
			_ = w.cmd.Process.Kill()
		}
		<-w.done
	}
	return nil
}

// selfExe 返回当前可执行文件路径，用于 re-exec frps-worker。
func selfExe() (string, error) { return os.Executable() }
