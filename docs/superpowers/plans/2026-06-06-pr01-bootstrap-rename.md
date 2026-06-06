# PR-01 基础重命名 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把项目机械重命名为 `cloudflared-manager` —— Go 模块路径 / 二进制名 / env 前缀 / selfupdate repo / Makefile / goreleaser / GitHub workflows / Docker 部署物 一并改。保留所有业务逻辑（frps 子进程模型暂留），删除 `frps-worker` 隐藏子命令。完成后：`go build` / `go vet` / `go test` 全绿，`docker build` 通过，`cfdmgrd serve` 能启动 HTTP API。**启动 frps 实例会失败 = 预期的过渡态**，由 PR-04 的 internal/process 模块替换。

**Architecture:** 三类机械改动：(1) 模块路径 `github.com/mia-clark/frps-manager` → `github.com/mia-clark/cloudflared-manager`（穿透所有 .go 文件的 import）；(2) 字符串前缀 `frpsmgrd` → `cfdmgrd` 与 `FRPSMGR_` → `CFDM_`（穿透 Go 源、Makefile、yml、Dockerfile、shell）；(3) `cmd/frpsmgrd/` 目录改名 + 删 `frps_worker.go` + `main.go` 删 `frps-worker` 分支。**不动**：`pkg/config/server.go`（PR-03 替换）、`internal/manager/worker.go`（PR-04 替换）、`fatedier/frp` 依赖（PR-11 清理）、`scripts/install.{sh,ps1}` / `README.md` / `CLAUDE.md` / `docs/API.zh-CN.md`（PR-10）。

**Tech Stack:** Go 1.25、`github.com/go-chi/chi/v5`、`modernc.org/sqlite`、`coder/websocket`、`shirou/gopsutil/v4`、`fsnotify`、`fatedier/frp v0.69.1`（暂留依赖）、`pelletier/go-toml/v2`（暂留依赖）。前端 React 19 / Vite 8 / Antd 6 本 PR 不动。构建链：Makefile + .goreleaser.yml + GitHub Actions + Docker 多阶段。

---

## 文件结构总览

| 路径 | 动作 | 说明 |
|---|---|---|
| `go.mod` | Modify | module 路径改名 |
| `go.sum` | Auto | `go mod tidy` 自动刷新 |
| 全部 `*.go`（约 40 文件） | Modify | 替换 `github.com/mia-clark/frps-manager` import path |
| `cmd/frpsmgrd/` | Rename → `cmd/cfdmgrd/` | git mv |
| `cmd/cfdmgrd/main.go` | Modify | 删 frps-worker 分支 + 改字面名 + import 路径 |
| `cmd/cfdmgrd/frps_worker.go` | **Delete** | frps-worker 子命令本体 |
| `internal/appcfg/appcfg.go` | Modify | env 前缀 `FRPSMGR_` → `CFDM_`；默认 DataDir 改为 `/var/lib/cfdmgrd` |
| `internal/selfupdate/selfupdate.go` | Modify | `defaultRepo` / 默认 install URL / env 名 / User-Agent |
| `internal/selfupdate/deploy.go` | Modify | launchd plist 路径改名 |
| `pkg/version/version.go` | Modify | 删 `FRPVersion` 变量 + 删 `fatedier/frp/pkg/util/version` import |
| `internal/api/system.go` | Modify | `/version` 响应去 `frp` 字段 |
| `internal/api/docs.go` | Modify | HTML 标题字面串改 |
| `Makefile` | Modify | 二进制名 `bin/frpsmgrd` → `bin/cfdmgrd`；删 `FRPVersion` ldflag；env 前缀；cmd 路径 |
| `.goreleaser.yml` | Modify | project_name / main / binary / ldflags / release.github / 文档链接 |
| `.github/workflows/tests.yml` | Modify | bin 名 / cmd 路径 / artifact 名 |
| `.github/workflows/release.yml` | Modify | label / footer / 文档链接 |
| `.github/workflows/golangci-lint.yml` | 无改动 | 文件无 frps* 字面 |
| `deploy/Dockerfile` | Modify | binary 名 / ldflags 模块路径 / ENV 前缀 / 注释 |
| `deploy/entrypoint.sh` | Modify | 二进制名 / DATA_DIR env 名 |
| `deploy/docker-compose.yml` | Modify | service 名 / image 名 / env 前缀 / healthcheck 命令 |
| `deploy/docker-compose.standalone.yml` | Modify | image / env / labels |
| `deploy/.env.example` | Modify | env 前缀 |
| `deploy/README.md` | Modify | 仅引用字面（不影响代码） |
| 所有测试文件 | 无改动 | `manager_test.go` / `logs_test.go` 已 grep 确认不含 frps* 字面 |
| `services/frps.go` | 无改动 | 暂留（PR-04 删 worker 时一并清理） |
| `pkg/config/server.go` | 无改动 | PR-03 替换 |
| `internal/manager/*.go` | 无改动（仅 import path 通过 sed 跟随） | PR-04 替换 worker.go |
| `web/` | 无改动 | PR-09 改 |

---

## Task 1：基线校验（确认起点干净）

**Files:** 无修改

- [ ] **Step 1.1：确认起点是干净 git 状态**

```bash
cd /d/Github_Codes_mia-clark/cloudflared-manager
git status
```

Expected: `working tree clean` 或仅有未跟踪的 `.claude/` / `docs/superpowers/`。如果有 uncommitted 业务文件 → **停下来**，让用户处理。

- [ ] **Step 1.2：确认前端 dist 已就绪（embed 必需）**

```bash
ls -la web/dist/index.html
```

Expected: 文件存在（大小 > 1KB）。

如果不存在：

```bash
cd web && npm ci --no-audit --no-fund --legacy-peer-deps && npm run build && cd ..
```

- [ ] **Step 1.3：基线 vet + test + build 全绿**

```bash
go vet ./... && go test ./... && go build -o /tmp/baseline-frpsmgrd ./cmd/frpsmgrd && rm /tmp/baseline-frpsmgrd
```

Expected: 三条命令依次返回 exit 0。若任一失败 → **基线就坏了**，不要继续重命名，先修基线。

- [ ] **Step 1.4：记录基线 import 路径数量（后续对账）**

```bash
grep -rln 'github.com/mia-clark/frps-manager' --include='*.go' --include='*.yml' --include='*.yaml' --include='Makefile' --include='Dockerfile' . | wc -l
```

Expected: 一个数字，例如 `45`。**记下来**，Task 2 完成后这个数字必须变成 `0`。

---

## Task 2：Go 模块路径重命名

**Files:**
- Modify: `go.mod`（line 1）
- Modify: 全部 `*.go` / `*.yml` / `Makefile` / `Dockerfile` 中含 `github.com/mia-clark/frps-manager` 的行

- [ ] **Step 2.1：改 `go.mod` 顶部 module 声明**

Read `go.mod` 第 1 行：

```go
module github.com/mia-clark/frps-manager
```

改为：

```go
module github.com/mia-clark/cloudflared-manager
```

执行：

```bash
sed -i '1s|^module github.com/mia-clark/frps-manager$|module github.com/mia-clark/cloudflared-manager|' go.mod
head -1 go.mod
```

Expected stdout: `module github.com/mia-clark/cloudflared-manager`

- [ ] **Step 2.2：跨文件批量替换所有 import / ldflags 路径**

```bash
grep -rln 'github.com/mia-clark/frps-manager' \
  --include='*.go' --include='*.yml' --include='*.yaml' \
  --include='Makefile' --include='Dockerfile' \
  . | while read -r f; do
  sed -i 's|github.com/mia-clark/frps-manager|github.com/mia-clark/cloudflared-manager|g' "$f"
done
```

- [ ] **Step 2.3：对账 —— 旧路径必须 0 命中**

```bash
grep -rln 'github.com/mia-clark/frps-manager' \
  --include='*.go' --include='*.yml' --include='*.yaml' \
  --include='Makefile' --include='Dockerfile' \
  . | wc -l
```

Expected: `0`

```bash
grep -rln 'github.com/mia-clark/cloudflared-manager' \
  --include='*.go' --include='*.yml' --include='*.yaml' \
  --include='Makefile' --include='Dockerfile' \
  . | wc -l
```

Expected: 与 Task 1.4 记录的基线数字相同（约 45）。

- [ ] **Step 2.4：编译验证 —— 路径已正确（此时 build 还会因为 frps-worker 等问题失败，仅 vet 应过）**

```bash
go vet ./... 2>&1 | head -30
```

Expected: **vet 应该通过**（exit 0）。如果报 `cannot find module` 之类 → 说明 sed 漏了文件，回到 Step 2.2 检查。

> 注意：此时不跑 `go build`，因为我们还没改其他依赖项（`pkg/version` 还 import `fatedier/frp/pkg/util/version`，但 vet 不会因为 import path 改名失败 —— 因为我们改的是**自己模块**的 import path，第三方的 `github.com/fatedier/frp/...` 不动）。

---

## Task 3：cmd 目录改名

**Files:**
- Rename dir: `cmd/frpsmgrd/` → `cmd/cfdmgrd/`

- [ ] **Step 3.1：git 友好地移动目录**

```bash
mkdir -p cmd/cfdmgrd
git mv cmd/frpsmgrd/main.go cmd/cfdmgrd/main.go
git mv cmd/frpsmgrd/frps_worker.go cmd/cfdmgrd/frps_worker.go
rmdir cmd/frpsmgrd
```

- [ ] **Step 3.2：确认移动后目录干净**

```bash
ls -la cmd/
```

Expected:

```
cfdmgrd/
```

（无 `frpsmgrd/` 残留）

```bash
ls -la cmd/cfdmgrd/
```

Expected:

```
main.go
frps_worker.go
```

---

## Task 4：删 `frps-worker` 子命令 + 重写 `main.go` 顶层

**Files:**
- Delete: `cmd/cfdmgrd/frps_worker.go`
- Modify: `cmd/cfdmgrd/main.go`（多处字面串 + 删 `frps-worker` 分支 + 删 `version.FRPVersion` 引用 + 改 usage / log 字面）

- [ ] **Step 4.1：删除 `frps_worker.go`**

```bash
git rm cmd/cfdmgrd/frps_worker.go
```

Expected: `rm 'cmd/cfdmgrd/frps_worker.go'`

- [ ] **Step 4.2：重写 `cmd/cfdmgrd/main.go` 全文**

把 `cmd/cfdmgrd/main.go` 整文件替换为下面内容。**注意**：这是最终内容，所有 `frpsmgrd` 字面、`frps-worker` 分支、`version.FRPVersion` 引用都已清掉。

```go
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/mia-clark/cloudflared-manager/internal/api"
	"github.com/mia-clark/cloudflared-manager/internal/appcfg"
	"github.com/mia-clark/cloudflared-manager/internal/eventbus"
	"github.com/mia-clark/cloudflared-manager/internal/manager"
	"github.com/mia-clark/cloudflared-manager/internal/metrics"
	"github.com/mia-clark/cloudflared-manager/pkg/version"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "serve":
		os.Exit(runServe(os.Args[2:]))
	case "health":
		os.Exit(runHealth(os.Args[2:]))
	case "version", "-v", "--version":
		fmt.Printf("cfdmgrd %s (built %s)\n", version.Number, version.BuildDate)
	case "help", "-h", "--help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `cfdmgrd — headless cloudflared multi-instance manager daemon

USAGE
  cfdmgrd <command> [flags]

COMMANDS
  serve     Run the HTTP API server (default for containers)
  health    Probe /api/v1/health and exit non-zero on failure
  version   Print version information
  help      Show this help

ENV
  CFDM_API_TOKEN       Required. Bearer token for API auth.
  CFDM_HTTP_ADDR       Listen address (default ":8080")
  CFDM_DATA_DIR        Data root (default "/var/lib/cfdmgrd")
  CFDM_CORS_ORIGINS    Comma-separated origins or "*" (default "*")
  CFDM_LOG_LEVEL       trace|debug|info|warn|error (default "info")
  CFDM_DOCS_ENABLED    Expose /api/docs Scalar UI (default "true")`)
}

func runServe(args []string) int {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	_ = fs.Parse(args)

	cfg, err := appcfg.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "config error: %v\n", err)
		return 1
	}
	if err := cfg.EnsureDirs(); err != nil {
		fmt.Fprintf(os.Stderr, "cannot create data dirs: %v\n", err)
		return 1
	}

	logger := newLogger(cfg.LogLevel)
	logger.Info("starting cfdmgrd",
		slog.String("addr", cfg.HTTPAddr),
		slog.String("data_dir", cfg.DataDir),
		slog.String("version", version.Number),
	)

	bus := eventbus.New(1024)
	mgr, err := manager.New(manager.Options{
		ProfilesDir: cfg.ProfilesDir,
		LogsDir:     cfg.LogsDir,
		StoresDir:   cfg.StoresDir,
		MetaPath:    cfg.MetaFile,
		Logger:      logger,
		Bus:         bus,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "init manager: %v\n", err)
		return 1
	}
	if err := mgr.LoadAll(); err != nil {
		fmt.Fprintf(os.Stderr, "load configs: %v\n", err)
		return 1
	}
	mgr.AutoStart()
	defer mgr.Shutdown()

	// 时序指标存储 + 采样器：纯 Go SQLite，落 $DataDir/metrics.db。
	// 采样器目前仍在调用 frps loopback —— PR-07 会重写为拉 cloudflared --metrics。
	mstore, err := metrics.Open(filepath.Join(cfg.DataDir, "metrics.db"))
	if err != nil {
		logger.Warn("metrics store disabled", slog.Any("err", err))
		mstore = nil
	} else {
		defer mstore.Close()
		sampler := metrics.NewSampler(mstore, mgr, bus, logger, 10*time.Second, 7*24*time.Hour)
		samplerCtx, cancelSampler := context.WithCancel(context.Background())
		defer cancelSampler()
		go sampler.Run(samplerCtx)
	}

	handler := api.NewRouter(api.Deps{Cfg: cfg, Logger: logger, Manager: mgr, Metrics: mstore})
	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-sigCh:
		logger.Info("shutdown signal received", slog.String("signal", sig.String()))
	case err := <-errCh:
		logger.Error("http server crashed", slog.Any("err", err))
		return 1
	}

	ctx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownWait)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("graceful shutdown failed", slog.Any("err", err))
		return 1
	}
	logger.Info("bye")
	return 0
}

func runHealth(args []string) int {
	fs := flag.NewFlagSet("health", flag.ExitOnError)
	addr := fs.String("addr", "http://127.0.0.1:8080", "daemon base URL")
	_ = fs.Parse(args)

	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(*addr + "/api/v1/health")
	if err != nil {
		fmt.Fprintf(os.Stderr, "health check failed: %v\n", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "unhealthy: status=%d\n", resp.StatusCode)
		return 1
	}
	return 0
}

func newLogger(level string) *slog.Logger {
	var lv slog.Level
	switch strings.ToLower(level) {
	case "trace", "debug":
		lv = slog.LevelDebug
	case "warn":
		lv = slog.LevelWarn
	case "error":
		lv = slog.LevelError
	default:
		lv = slog.LevelInfo
	}
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: lv}))
}
```

执行覆盖（用 Write 工具 / Edit 工具替换全文）。

- [ ] **Step 4.3：验证 main.go 单文件 vet 通过**

```bash
go vet ./cmd/cfdmgrd
```

Expected: exit 0，无输出。

---

## Task 5：appcfg 环境变量前缀重命名

**Files:**
- Modify: `internal/appcfg/appcfg.go`

- [ ] **Step 5.1：写新版 `internal/appcfg/appcfg.go`**

整体替换文件内容为：

```go
package appcfg

import (
	"errors"
	"os"
	"strings"
	"time"
)

// Config is the daemon's own runtime configuration, populated from env vars.
type Config struct {
	HTTPAddr     string
	APIToken     string
	CORSOrigins  []string
	DataDir      string
	ProfilesDir  string
	LogsDir      string
	StoresDir    string
	MetaFile     string
	LogLevel     string
	DocsEnabled  bool
	// SelfUpdateEnabled gates the web-triggered self-update endpoint
	// (POST /api/v1/system/update). It maps to CFDM_SELF_UPDATE_ENABLED
	// and defaults to true. Operators running immutable deployments can set
	// it to false to disable in-place upgrades from the UI.
	SelfUpdateEnabled bool
	ShutdownWait      time.Duration
}

// Load reads configuration from environment variables. Required fields
// without sensible defaults will return an error.
func Load() (*Config, error) {
	cfg := &Config{
		HTTPAddr:    getEnv("CFDM_HTTP_ADDR", ":8080"),
		APIToken:    os.Getenv("CFDM_API_TOKEN"),
		CORSOrigins: splitCSV(getEnv("CFDM_CORS_ORIGINS", "*")),
		DataDir:     getEnv("CFDM_DATA_DIR", defaultDataDir()),
		LogLevel:    strings.ToLower(getEnv("CFDM_LOG_LEVEL", "info")),
		DocsEnabled: parseBool(getEnv("CFDM_DOCS_ENABLED", "true"), true),

		SelfUpdateEnabled: parseBool(getEnv("CFDM_SELF_UPDATE_ENABLED", "true"), true),
		ShutdownWait:      10 * time.Second,
	}
	cfg.ProfilesDir = cfg.DataDir + "/profiles"
	cfg.LogsDir = cfg.DataDir + "/logs"
	cfg.StoresDir = cfg.DataDir + "/stores"
	cfg.MetaFile = cfg.DataDir + "/meta.json"

	if cfg.APIToken == "" {
		return nil, errors.New("CFDM_API_TOKEN is required")
	}
	return cfg, nil
}

// EnsureDirs creates the data subdirectories if they do not exist.
func (c *Config) EnsureDirs() error {
	for _, d := range []string{c.DataDir, c.ProfilesDir, c.LogsDir, c.StoresDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	return nil
}

// defaultDataDir picks a sane default per OS. The installer scripts and
// Dockerfile override CFDM_DATA_DIR explicitly so this only matters when
// users run cfdmgrd by hand without env vars set.
func defaultDataDir() string {
	// Windows: %ProgramData%\cfdmgrd 由安装脚本注入；裸跑兜底回当前目录的 ./data
	// Linux/Darwin: /var/lib/cfdmgrd
	if p := os.Getenv("ProgramData"); p != "" {
		return p + `\cfdmgrd`
	}
	return "/var/lib/cfdmgrd"
}

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func parseBool(s string, def bool) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on", "y":
		return true
	case "0", "false", "no", "off", "n":
		return false
	default:
		return def
	}
}

func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
```

- [ ] **Step 5.2：验证 appcfg 单包 vet + test**

```bash
go vet ./internal/appcfg/...
```

Expected: exit 0。

```bash
go test ./internal/appcfg/...
```

Expected: 没有 test 文件，输出 `?   github.com/mia-clark/cloudflared-manager/internal/appcfg [no test files]`（exit 0）。

---

## Task 6：selfupdate repo / 默认 install URL / User-Agent / launchd plist

**Files:**
- Modify: `internal/selfupdate/selfupdate.go`（5 处常量 + 注释）
- Modify: `internal/selfupdate/deploy.go`（launchd plist 路径）

- [ ] **Step 6.1：改 `internal/selfupdate/selfupdate.go`**

将以下原始片段（line 25-32）：

```go
const (
	defaultRepo       = "mia-clark/frps-manager"
	defaultInstallSh  = "https://raw.githubusercontent.com/mia-clark/frps-manager/main/scripts/install.sh"
	defaultInstallPs1 = "https://raw.githubusercontent.com/mia-clark/frps-manager/main/scripts/install.ps1"
	cacheTTL          = time.Hour
	httpTimeout       = 12 * time.Second
)
```

替换为：

```go
const (
	defaultRepo       = "mia-clark/cloudflared-manager"
	defaultInstallSh  = "https://raw.githubusercontent.com/mia-clark/cloudflared-manager/main/scripts/install.sh"
	defaultInstallPs1 = "https://raw.githubusercontent.com/mia-clark/cloudflared-manager/main/scripts/install.ps1"
	cacheTTL          = time.Hour
	httpTimeout       = 12 * time.Second
)
```

将以下原始片段（行号约 50-58 之间的 Config 字段注释）：

```go
	// InstallShURL / InstallPs1URL point at the installer scripts the spawned
	// updater downloads. Empty values fall back to the official raw URLs,
	// overridable via FRPSMGR_INSTALL_SH_URL / FRPSMGR_INSTALL_PS1_URL.
```

替换为：

```go
	// InstallShURL / InstallPs1URL point at the installer scripts the spawned
	// updater downloads. Empty values fall back to the official raw URLs,
	// overridable via CFDM_INSTALL_SH_URL / CFDM_INSTALL_PS1_URL.
```

将以下原始片段（行号约 51 的 Config.Repo 注释）：

```go
	// Repo is the "owner/name" GitHub repo. Defaults to mia-clark/frps-manager.
```

替换为：

```go
	// Repo is the "owner/name" GitHub repo. Defaults to mia-clark/cloudflared-manager.
```

将以下原始片段（New 函数体内的 env 名）：

```go
	if cfg.InstallShURL == "" {
		cfg.InstallShURL = env("FRPSMGR_INSTALL_SH_URL", defaultInstallSh)
	}
	if cfg.InstallPs1URL == "" {
		cfg.InstallPs1URL = env("FRPSMGR_INSTALL_PS1_URL", defaultInstallPs1)
	}
```

替换为：

```go
	if cfg.InstallShURL == "" {
		cfg.InstallShURL = env("CFDM_INSTALL_SH_URL", defaultInstallSh)
	}
	if cfg.InstallPs1URL == "" {
		cfg.InstallPs1URL = env("CFDM_INSTALL_PS1_URL", defaultInstallPs1)
	}
```

将 fetchOne 中的 User-Agent：

```go
	req.Header.Set("User-Agent", "frpsmgrd-selfupdate")
```

替换为：

```go
	req.Header.Set("User-Agent", "cfdmgrd-selfupdate")
```

将顶部 package doc 注释第 1 行：

```go
// Package selfupdate queries the latest GitHub release of frps-manager,
```

替换为：

```go
// Package selfupdate queries the latest GitHub release of cloudflared-manager,
```

- [ ] **Step 6.2：改 `internal/selfupdate/deploy.go`**

将以下原始片段（line 36-39）：

```go
	case "darwin":
		if fileExists("/Library/LaunchDaemons/com.miaclark.frpsmgrd.plist") {
			return ModeLaunchd
		}
		return ModeManual
```

替换为：

```go
	case "darwin":
		if fileExists("/Library/LaunchDaemons/com.miaclark.cfdmgrd.plist") {
			return ModeLaunchd
		}
		return ModeManual
```

将以下原始片段（line 59 的错误提示）：

```go
		return false, "未检测到系统服务（疑似手动运行），无法自动替换二进制并重启；请用安装脚本装成服务后再用一键更新，或改用命令行 fms update"
```

替换为：

```go
		return false, "未检测到系统服务（疑似手动运行），无法自动替换二进制并重启；请用安装脚本装成服务后再用一键更新，或改用命令行 cfm update"
```

- [ ] **Step 6.3：搜索剩余 selfupdate 包内 frps* 残留**

```bash
grep -n -E 'FRPSMGR_|frpsmgrd|frps-manager' internal/selfupdate/*.go
```

Expected: 仅 `update_unix.go` / `update_windows.go` 之类可能还残留——逐个看输出，把剩余字面替换。

```bash
grep -rln -E 'FRPSMGR_|frpsmgrd|frps-manager' internal/selfupdate/ | while read -r f; do
  sed -i \
    -e 's/FRPSMGR_/CFDM_/g' \
    -e 's/frpsmgrd/cfdmgrd/g' \
    -e 's/frps-manager/cloudflared-manager/g' \
    "$f"
done
grep -rn -E 'FRPSMGR_|frpsmgrd|frps-manager' internal/selfupdate/
```

Expected: 第二条 grep 无输出。

- [ ] **Step 6.4：验证 selfupdate 包 vet**

```bash
go vet ./internal/selfupdate/...
```

Expected: exit 0。

---

## Task 7：pkg/version 移除 FRPVersion

**Files:**
- Modify: `pkg/version/version.go`（删 import + 删 FRPVersion 变量）

- [ ] **Step 7.1：把 `pkg/version/version.go` 整体替换为：**

```go
package version

// These values are overridden at build time via -ldflags -X (see
// .goreleaser.yml and deploy/Dockerfile). Defaults are placeholders so
// `go run` works during development.
var (
	Number = "0.0.10"
	// BuildDate is the day that this program was built
	BuildDate = "unknown"
)
```

- [ ] **Step 7.2：验证 pkg/version 包**

```bash
go vet ./pkg/version/...
```

Expected: exit 0。

```bash
go test ./pkg/version/...
```

Expected: 没 test 或 PASS。

- [ ] **Step 7.3：确认无其它包仍引用 `version.FRPVersion`**

```bash
grep -rn 'version\.FRPVersion' --include='*.go' .
```

Expected: 无输出（Task 4 已删 main.go 的引用；Task 8 会删 api/system.go 的引用）。如果有残留，记下文件 + 行号，在 Task 8 一并处理。

---

## Task 8：api/system.go 的 `/version` 响应去 frp 字段

**Files:**
- Modify: `internal/api/system.go`（line 36-43 区段）

- [ ] **Step 8.1：将原 Version handler：**

```go
// Version reports the daemon version, embedded frp version and build date.
func (s *SystemHandler) Version(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]any{
		"daemon":     version.Number,
		"frp":        version.FRPVersion,
		"build_date": version.BuildDate,
	})
}
```

替换为：

```go
// Version reports the daemon version and build date. The cloudflared
// binary version is reported by /api/v1/binaries (added in PR-05).
func (s *SystemHandler) Version(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]any{
		"daemon":     version.Number,
		"build_date": version.BuildDate,
	})
}
```

- [ ] **Step 8.2：验证 api 包 vet**

```bash
go vet ./internal/api/...
```

Expected: exit 0。

---

## Task 9：api/docs.go 标题字面

**Files:**
- Modify: `internal/api/docs.go`（line 28）

- [ ] **Step 9.1：将原行：**

```go
  <title>frpsmgrd API</title>
```

替换为：

```go
  <title>cfdmgrd API</title>
```

具体命令：

```bash
sed -i 's|<title>frpsmgrd API</title>|<title>cfdmgrd API</title>|' internal/api/docs.go
grep -n 'cfdmgrd API' internal/api/docs.go
```

Expected: `28:  <title>cfdmgrd API</title>`

---

## Task 10：Makefile 重命名 + LDFLAGS 清理

**Files:**
- Modify: `Makefile` 全文

- [ ] **Step 10.1：将 `Makefile` 整体替换为：**

```makefile
SHELL := /bin/sh
VERSION ?= dev
BUILD_DATE := $(shell date -u +%Y-%m-%d)
LDFLAGS := -s -w \
    -X github.com/mia-clark/cloudflared-manager/pkg/version.Number=$(VERSION) \
    -X github.com/mia-clark/cloudflared-manager/pkg/version.BuildDate=$(BUILD_DATE)

.PHONY: build build-host web web-install test vet tidy clean docker run

# 前端依赖 — 仅在 node_modules 缺失时跑一次完整 install
web-install:
	test -d web/node_modules || (cd web && npm ci)

# 构建前端 dist —— 嵌入到 Go 二进制需要的产物
# 必须在 build / docker 之前执行；否则 //go:embed dist 会失败或得到空 FS
web: web-install
	cd web && npm run build

# Go 跨平台 (Linux/amd64) 构建 daemon —— 镜像里用这个
# 自动先 build web，确保 dist 是最新的
build: web
	CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags "$(LDFLAGS)" -o bin/cfdmgrd ./cmd/cfdmgrd

# 本机平台构建（Windows/Mac/Linux 通用），用于本地开发跑 daemon
build-host: web
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/cfdmgrd ./cmd/cfdmgrd

test:
	go test ./...

vet:
	go vet ./...

tidy:
	go mod tidy

clean:
	rm -rf bin/ web/dist/

# Docker 镜像构建：Dockerfile 自带 node:20 + golang:1.25 多阶段，
# 内部完成 npm build + go build。任何环境（本地 / CI / 干净 clone）
# 都可直接跑，无前置依赖。
docker:
	docker build -f deploy/Dockerfile -t cloudflared-manager:$(VERSION) \
	  --build-arg VERSION=$(VERSION) \
	  --build-arg BUILD_DATE=$(BUILD_DATE) \
	  .

run: build-host
	CFDM_API_TOKEN=dev CFDM_DATA_DIR=./tmp/data ./bin/cfdmgrd serve
```

- [ ] **Step 10.2：验证 Makefile 语法（make 不会真跑全流程，先列目标）**

```bash
make -n vet
```

Expected: 输出 `go vet ./...`（无 error）。

---

## Task 11：.goreleaser.yml 全文重命名

**Files:**
- Modify: `.goreleaser.yml` 全文

- [ ] **Step 11.1：将 `.goreleaser.yml` 整体替换为：**

```yaml
version: 2

project_name: cfdmgrd

before:
  hooks:
    - go mod tidy

builds:
  - id: cfdmgrd
    main: ./cmd/cfdmgrd
    binary: cfdmgrd
    env:
      - CGO_ENABLED=0
    flags:
      - -trimpath
    ldflags:
      - -s -w
      - -X github.com/mia-clark/cloudflared-manager/pkg/version.Number={{.Version}}
      - -X github.com/mia-clark/cloudflared-manager/pkg/version.BuildDate={{.Date}}
    # 显式目标清单。modernc.org/sqlite 依赖的 modernc.org/libc 不为 mips/mipsle/
    # mips64/mips64le/loong64 提供 platform-specific 源文件 (undefined: newFile/long
    # /ulong)，这些目标会编译失败，故移除。riscv64 由 modernc/libc v1.61+ 支持。
    # arm 用 goarm 后缀 (v6/v7)；amd64/arm64/386/riscv64 用默认微架构。
    targets:
      - linux_amd64
      - linux_arm64
      - linux_arm_6
      - linux_arm_7
      - linux_386
      - linux_riscv64
      - darwin_amd64
      - darwin_arm64
      - windows_amd64
      - windows_arm64
      - windows_386
      - freebsd_amd64
      - freebsd_arm64
      # 不发布：mips/mipsle/mips64/mips64le/loong64 — modernc.org/libc 缺源
      # 不发布：android_arm64 — wlynxg/anet 在 Go 1.25 下 linkname net.zoneCache
      #         失效；termux 用户可直接用 linux_arm64 静态二进制

archives:
  - id: default
    formats: [tar.gz]
    format_overrides:
      - goos: windows
        formats: [zip]
    name_template: >-
      {{ .ProjectName }}_{{ .Version }}_{{ .Os }}_{{ .Arch }}{{ with .Arm }}v{{ . }}{{ end }}
    files:
      - README.md
      - LICENSE
      - CHANGELOG.md

checksum:
  name_template: "checksums.txt"
  algorithm: sha256

snapshot:
  version_template: "{{ incpatch .Version }}-dev+{{ .ShortCommit }}"

changelog:
  use: github
  sort: asc
  filters:
    exclude:
      - "^docs:"
      - "^test:"
      - "^chore:"
      - "^ci:"
      - "Merge pull request"
      - "Merge branch"
  groups:
    - title: "Features"
      regexp: '^.*?feat(\(.+\))??:.+$'
      order: 0
    - title: "Bug fixes"
      regexp: '^.*?fix(\(.+\))??:.+$'
      order: 1
    - title: "Other"
      order: 999

release:
  draft: false
  prerelease: auto
  mode: replace
  github:
    owner: mia-clark
    name: cloudflared-manager
  header: |
    ## cfdmgrd {{ .Tag }}

    Built from [`{{ .ShortCommit }}`](https://github.com/mia-clark/cloudflared-manager/commit/{{ .FullCommit }}).
  footer: |
    ---

    Container image: `ghcr.io/mia-clark/cloudflared-manager:{{ .Version }}`
```

> 注：上面已删 `docs/README-server.md` 的 archives.files 行（spec PR-14 标记此文件 DELETE），且删 footer 中对该文档的引用。

- [ ] **Step 11.2：用 goreleaser 检查语法（如本机有装）**

```bash
which goreleaser >/dev/null 2>&1 && goreleaser check || echo "goreleaser not installed locally; CI will validate"
```

Expected: `Check successful` 或 `goreleaser not installed locally; CI will validate`。

---

## Task 12：GitHub Actions workflows 重命名

**Files:**
- Modify: `.github/workflows/tests.yml`
- Modify: `.github/workflows/release.yml`
- 无需改: `.github/workflows/golangci-lint.yml`（grep 已确认无 frps 字面）

- [ ] **Step 12.1：改 `.github/workflows/tests.yml`**

将 line 39-55（build 与 smoke run 段）：

```yaml
      - name: build (linux/amd64 static)
        env:
          CGO_ENABLED: '0'
          GOOS: linux
          GOARCH: amd64
        run: |
          go build -trimpath -ldflags="-s -w" -o bin/frpsmgrd ./cmd/frpsmgrd
          file bin/frpsmgrd

      - name: smoke run --version
        run: ./bin/frpsmgrd version

      - uses: actions/upload-artifact@v4
        if: github.event_name == 'pull_request'
        with:
          name: frpsmgrd-linux-amd64
          path: bin/frpsmgrd
          retention-days: 7
```

替换为：

```yaml
      - name: build (linux/amd64 static)
        env:
          CGO_ENABLED: '0'
          GOOS: linux
          GOARCH: amd64
        run: |
          go build -trimpath -ldflags="-s -w" -o bin/cfdmgrd ./cmd/cfdmgrd
          file bin/cfdmgrd

      - name: smoke run --version
        run: ./bin/cfdmgrd version

      - uses: actions/upload-artifact@v4
        if: github.event_name == 'pull_request'
        with:
          name: cfdmgrd-linux-amd64
          path: bin/cfdmgrd
          retention-days: 7
```

- [ ] **Step 12.2：改 `.github/workflows/release.yml`**

将 docker job 的 `labels` 段（约 line 225-228）：

```yaml
          labels: |
            org.opencontainers.image.title=frps-manager
            org.opencontainers.image.description=Headless FRP client manager with REST + WebSocket API
            org.opencontainers.image.licenses=GPL-3.0
            org.opencontainers.image.version=${{ needs.bump.outputs.version }}
```

替换为：

```yaml
          labels: |
            org.opencontainers.image.title=cloudflared-manager
            org.opencontainers.image.description=Headless cloudflared multi-instance manager with REST + WebSocket API
            org.opencontainers.image.licenses=GPL-3.0
            org.opencontainers.image.version=${{ needs.bump.outputs.version }}
```

- [ ] **Step 12.3：搜剩余残留**

```bash
grep -rn -E 'frpsmgrd|frps-manager|FRPSMGR_' .github/workflows/
```

Expected: 无输出。如有 → 据上下文用 Edit 工具替换。

---

## Task 13：Docker 部署物全套重命名

**Files:**
- Modify: `deploy/Dockerfile`
- Modify: `deploy/entrypoint.sh`
- Modify: `deploy/docker-compose.yml`
- Modify: `deploy/docker-compose.standalone.yml`
- Modify: `deploy/.env.example`
- Modify: `deploy/README.md`

- [ ] **Step 13.1：改 `deploy/Dockerfile`**

将注释里的 `frpsmgrd` 字面 + ldflags + ENV 块都改名。具体替换：

将 line 6-7（注释）：

```
#                     (前端通过 //go:embed dist 嵌入 frpsmgrd)
#   3. runtime     —— alpine:3.20 + su-exec，只装 frpsmgrd 这一个产物
```

替换为：

```
#                     (前端通过 //go:embed dist 嵌入 cfdmgrd)
#   3. runtime     —— alpine:3.20 + su-exec，只装 cfdmgrd 这一个产物
```

将 line 56-61（go build 命令）：

```
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} GOARM=${TARGETVARIANT#v} go build \
    -trimpath \
    -ldflags="-s -w \
      -X github.com/mia-clark/cloudflared-manager/pkg/version.Number=${VERSION} \
      -X github.com/mia-clark/cloudflared-manager/pkg/version.BuildDate=${BUILD_DATE}" \
    -o /out/frpsmgrd ./cmd/frpsmgrd
```

替换为（仅产物名 + cmd 路径）：

```
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} GOARM=${TARGETVARIANT#v} go build \
    -trimpath \
    -ldflags="-s -w \
      -X github.com/mia-clark/cloudflared-manager/pkg/version.Number=${VERSION} \
      -X github.com/mia-clark/cloudflared-manager/pkg/version.BuildDate=${BUILD_DATE}" \
    -o /out/cfdmgrd ./cmd/cfdmgrd
```

（Task 2 sed 已经把模块路径改对，这里只需改产物名 + cmd 路径。）

将 line 74-76（runtime stage COPY）：

```
COPY --from=build /out/frpsmgrd /usr/local/bin/frpsmgrd
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/frpsmgrd
```

替换为：

```
COPY --from=build /out/cfdmgrd /usr/local/bin/cfdmgrd
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/cfdmgrd
```

将 line 78-81（ENV 块）：

```
ENV FRPSMGR_DATA_DIR=/data \
    FRPSMGR_HTTP_ADDR=:8080 \
    FRPSMGR_LOG_LEVEL=info \
    FRPSMGR_CORS_ORIGINS="*"
```

替换为：

```
ENV CFDM_DATA_DIR=/data \
    CFDM_HTTP_ADDR=:8080 \
    CFDM_LOG_LEVEL=info \
    CFDM_CORS_ORIGINS="*"
```

- [ ] **Step 13.2：改 `deploy/entrypoint.sh`**

将 line 2：

```
# frpsmgrd container entrypoint.
```

替换为：

```
# cfdmgrd container entrypoint.
```

将 line 10：

```
DATA_DIR="${FRPSMGR_DATA_DIR:-/data}"
```

替换为：

```
DATA_DIR="${CFDM_DATA_DIR:-/data}"
```

将 line 30 与 line 33：

```
    exec /usr/local/bin/frpsmgrd "$@"
...
exec su-exec "${RUN_UID}:${RUN_GID}" /usr/local/bin/frpsmgrd "$@"
```

替换为：

```
    exec /usr/local/bin/cfdmgrd "$@"
...
exec su-exec "${RUN_UID}:${RUN_GID}" /usr/local/bin/cfdmgrd "$@"
```

- [ ] **Step 13.3：改 `deploy/docker-compose.yml`**

将 service / image / env 全部 sed 替换：

```bash
sed -i \
  -e 's/frpsmgrd:/cfdmgrd:/g' \
  -e 's/frps-manager:/cloudflared-manager:/g' \
  -e 's/container_name: frpsmgrd/container_name: cfdmgrd/' \
  -e 's/FRPSMGR_/CFDM_/g' \
  -e 's|/usr/local/bin/frpsmgrd|/usr/local/bin/cfdmgrd|g' \
  deploy/docker-compose.yml
grep -n -E 'frpsmgrd|frps-manager|FRPSMGR_' deploy/docker-compose.yml
```

Expected: 第二条 grep 无输出。

- [ ] **Step 13.4：改 `deploy/docker-compose.standalone.yml`**

```bash
sed -i \
  -e 's/frpsmgrd:/cfdmgrd:/g' \
  -e 's/frps-manager:/cloudflared-manager:/g' \
  -e 's/container_name: docker_frpsmgrd/container_name: docker_cfdmgrd/' \
  -e 's/FRPSMGR_/CFDM_/g' \
  -e 's/FRPSMGR_HTTP_PORT/CFDM_HTTP_PORT/g' \
  deploy/docker-compose.standalone.yml
grep -n -E 'frpsmgrd|frps-manager|FRPSMGR_' deploy/docker-compose.standalone.yml
```

Expected: 无输出。

- [ ] **Step 13.5：改 `deploy/.env.example`**

```bash
sed -i \
  -e 's/FRPSMGR_/CFDM_/g' \
  deploy/.env.example
grep -n -E 'frpsmgrd|frps-manager|FRPSMGR_' deploy/.env.example
```

Expected: 无输出。

- [ ] **Step 13.6：改 `deploy/README.md`**

```bash
sed -i \
  -e 's/frpsmgrd/cfdmgrd/g' \
  -e 's/frps-manager/cloudflared-manager/g' \
  -e 's/FRPSMGR_/CFDM_/g' \
  deploy/README.md
grep -n -E 'frpsmgrd|frps-manager|FRPSMGR_' deploy/README.md
```

Expected: 无输出。

> README.md 内的"Headless FRP client manager"等业务描述本 PR 不动（PR-10 全文重写）。

---

## Task 14：全量验证 vet + test + build

**Files:** 无修改

- [ ] **Step 14.1：跑 `go mod tidy`**

```bash
go mod tidy
```

Expected: 退出 0，可能更新 `go.sum`（仅删除/更新与 self 模块路径无关的 indirect）。

- [ ] **Step 14.2：全量 vet**

```bash
go vet ./...
```

Expected: exit 0，无输出。

- [ ] **Step 14.3：全量 test**

```bash
go test ./...
```

Expected: 所有包 PASS 或 `[no test files]`，exit 0。

> 调研已确认 `manager_test.go` / `logs_test.go` / `worker_test.go` / `meta_test.go` / `server_test.go` / `manager_test.go` 全部不含 `FRPSMGR_` / `frpsmgrd` 字面，所以这一步不应有失败。如有失败：
> - 优先看是不是 import path 问题（Task 2 sed 漏了）
> - 其次是不是 env 名 hard-coded 在测试 setup
>
> 失败时贴出失败的包 + 前 30 行 panic，主线决定是否打补丁。

- [ ] **Step 14.4：本机 build**

```bash
go build -trimpath -ldflags "-X github.com/mia-clark/cloudflared-manager/pkg/version.Number=dev -X github.com/mia-clark/cloudflared-manager/pkg/version.BuildDate=$(date -u +%Y-%m-%d)" -o bin/cfdmgrd ./cmd/cfdmgrd
ls -la bin/cfdmgrd
```

Expected: 二进制存在，约 30-35 MB。

- [ ] **Step 14.5：smoke `version` 子命令**

```bash
./bin/cfdmgrd version
```

Expected: `cfdmgrd dev (built YYYY-MM-DD)`（无 `frp X.Y.Z` 后缀）。

- [ ] **Step 14.6：smoke `help` 子命令**

```bash
./bin/cfdmgrd help
```

Expected stderr 含：

```
cfdmgrd — headless cloudflared multi-instance manager daemon
...
ENV
  CFDM_API_TOKEN
  CFDM_HTTP_ADDR
  CFDM_DATA_DIR
  CFDM_CORS_ORIGINS
  CFDM_LOG_LEVEL
  CFDM_DOCS_ENABLED
```

- [ ] **Step 14.7：对账剩余 frps* 字面（应只在文档与 spec 提及）**

```bash
grep -rn -E 'FRPSMGR_|frpsmgrd|frps-manager' \
  --include='*.go' --include='*.yml' --include='*.yaml' \
  --include='Makefile' --include='Dockerfile' --include='*.sh' \
  . 2>/dev/null | grep -v -E '^docs/superpowers/' | grep -v -E '^scripts/install\.(sh|ps1)' | grep -v -E '^README\.md' | grep -v -E '^CLAUDE\.md' | grep -v -E '^CHANGELOG\.md' | grep -v -E '^docs/(API|README-server)'
```

Expected: **无输出**（所有"非文档"文件已清完）。如有残留，逐个用 Edit 工具修。

---

## Task 15：手动启动 smoke

**Files:** 无修改

- [ ] **Step 15.1：用临时数据目录启动**

```bash
rm -rf ./tmp/data
mkdir -p ./tmp/data
CFDM_API_TOKEN=dev CFDM_DATA_DIR=./tmp/data ./bin/cfdmgrd serve &
SERVE_PID=$!
sleep 2
```

Expected: 后台启动；stderr 含 `level=INFO msg="starting cfdmgrd" addr=":8080" data_dir=./tmp/data version=dev`（注意：**没有** `frp=...` 字段，确认 Task 4 改对）。

- [ ] **Step 15.2：探活 /health**

```bash
curl -fsS http://127.0.0.1:8080/api/v1/health
```

Expected JSON：

```json
{"status":"ok","uptime_s":2}
```

- [ ] **Step 15.3：探 /version**

```bash
curl -fsS -H "Authorization: Bearer dev" http://127.0.0.1:8080/api/v1/version
```

Expected JSON（无 `frp` 字段）：

```json
{"daemon":"dev","build_date":"unknown"}
```

> 注意：如果 ldflags 在 build 时未注入，会是 `daemon: "0.0.10"` / `build_date: "unknown"`，这也对。

- [ ] **Step 15.4：列 configs（应为空数组，但接口能跑）**

```bash
curl -fsS -H "Authorization: Bearer dev" http://127.0.0.1:8080/api/v1/configs
```

Expected: `{"items":[]}` 或 `[]`（取决于 handler 形态），HTTP 200。

- [ ] **Step 15.5：清理**

```bash
kill $SERVE_PID
wait $SERVE_PID 2>/dev/null
rm -rf ./tmp/data
```

> **不做**：尝试创建并启动一个 frps 配置。spec 已明确 PR-01 后启动实例会失败（frps-worker 被删），这是预期过渡态。PR-04 重写 worker 后才恢复。

---

## Task 16：单次大 commit

**Files:** git stage + commit

- [ ] **Step 16.1：检查 staged 与未跟踪文件**

```bash
git status
```

Expected:

- `modified`: 多数 .go / yml / Dockerfile / Makefile / appcfg.go / version.go / system.go / docs.go / selfupdate.go / deploy.go / 所有 deploy/*
- `deleted`: `cmd/frpsmgrd/main.go`、`cmd/frpsmgrd/frps_worker.go`
- `new file` （由 git mv 触发的）: `cmd/cfdmgrd/main.go`、`cmd/cfdmgrd/frps_worker.go`（后者实际已 git rm 又重建 git mv 时会有点别扭，确认 Task 4.1 是直接 `git rm` 即可）
- 可能：`go.sum` 修改

- [ ] **Step 16.2：stage 全部改动**

```bash
git add -A
```

- [ ] **Step 16.3：commit**

```bash
git commit -m "$(cat <<'EOF'
chore(rebrand): PR-01 基础重命名 frps-manager → cloudflared-manager

- Go 模块路径 github.com/mia-clark/frps-manager → cloudflared-manager
- 二进制 frpsmgrd → cfdmgrd；cmd 目录 cmd/frpsmgrd → cmd/cfdmgrd
- env 前缀 FRPSMGR_ → CFDM_（appcfg/selfupdate/Dockerfile/compose/.env.example）
- 默认 DataDir /data → /var/lib/cfdmgrd（Windows 走 %ProgramData%\cfdmgrd）
- selfupdate repo / install URL / launchd plist 跟随重命名
- 删除 frps-worker 隐藏子命令与 cmd/cfdmgrd/frps_worker.go
- 删除 pkg/version.FRPVersion + /api/v1/version 响应中的 frp 字段
- Makefile / .goreleaser.yml / .github/workflows/{tests,release}.yml 跟随重命名
- 暂留：fatedier/frp 依赖、pkg/config/server.go、internal/manager/worker.go、
  services/frps.go、scripts/install.{sh,ps1}、README.md、CLAUDE.md、docs/API
  这些在后续 PR-03/04/10/11 处理。

过渡态：本 PR 后 daemon 可启动 + API 可列配置，但启动 frps 实例会失败
（frps-worker 子命令已删），由 PR-04 的 internal/process 模块替换。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: commit 成功，输出包含 `[main <hash>]` 与改动行数。

- [ ] **Step 16.4：再确认 working tree 干净**

```bash
git status
```

Expected: `working tree clean`（仅可能有 spec / plan 文档未跟踪，主线判断是否一并 commit）。

---

## Self-Review（Plan 自审）

✅ **Spec 覆盖**（spec §13 PR-01 列出的 5 项）：
- cmd 重命名 → Task 3 + Task 4
- Makefile 重命名 → Task 10
- go.mod 模块名 → Task 2
- appcfg env 前缀 → Task 5
- selfupdate repo 名 → Task 6
- 删 frps-worker 子命令 → Task 4

✅ **隐含覆盖**（spec 未在 PR-01 显式列但必须做）：
- pkg/version 删 FRPVersion → Task 7（否则 main.go / system.go 编不过）
- internal/api/system.go /version 响应 → Task 8（同上）
- internal/api/docs.go 标题 → Task 9（视觉一致性，不影响编译，但成本极低）
- .goreleaser.yml + workflows → Task 11 + 12（否则 CI 出错）
- Dockerfile + compose + entrypoint → Task 13（否则 `make docker` 与 `docker compose up` 失败）
- launchd plist 路径 → Task 6.2（selfupdate 探测会找不到旧路径）

✅ **类型一致性**：
- env 名贯穿一致：`CFDM_API_TOKEN` / `CFDM_HTTP_ADDR` / `CFDM_DATA_DIR` / `CFDM_CORS_ORIGINS` / `CFDM_LOG_LEVEL` / `CFDM_DOCS_ENABLED` / `CFDM_SELF_UPDATE_ENABLED` / `CFDM_INSTALL_SH_URL` / `CFDM_INSTALL_PS1_URL`（appcfg 与 main.go usage 与 deploy/* 完全对齐）
- 二进制 / 命令名贯穿：`cfdmgrd`（cmd 目录、Makefile 输出、Dockerfile 产物、entrypoint、compose、goreleaser、main.go 自报名、help 文本、API docs HTML title）
- 模块路径贯穿：`github.com/mia-clark/cloudflared-manager`（go.mod、所有 import、Makefile/Dockerfile/goreleaser ldflags、selfupdate defaultRepo / defaultInstall*）

✅ **占位符扫描**：
- 无 TBD / TODO / FIXME / XXX 残留
- 每个 step 含可直接执行命令 + 期望输出

✅ **过渡态澄清**：
- Step 15 明确 "**不做**：启动 frps 配置实例"
- commit message 明确"过渡态：启动实例会失败"

⚠️ **风险点**：
1. `go mod tidy` 可能在某些环境下因网络问题失败 —— 提供 mirror 备用，但本 PR 不必硬扛。
2. `services/frps.go` 残留 `fatedier/frp` import，但因为它本身有 sed 改正的 import path，编译能过。它现在是孤儿包（无引用），`go build` 不会编译它（除非 `go build ./...`）。Task 14.2 跑 `go vet ./...` 会扫到，但因为 services 包内部 still uses frp 类型，vet 应该 PASS（只是无人调用）。如果 vet 报"package services is unused" 之类警告 → 这是误报，可忽略；如果是错误 → 把 `services/` 临时 `git mv` 到 `.archive/services/` 让 go 不扫描（spec PR-04 会删）。
3. 升级 Go 模块路径后，IDE（VS Code Go 插件）需要 reload，否则可能误报。提示用户：`make tidy && code . --reload-window`。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-06-pr01-bootstrap-rename.md`. Two execution options:

**1. Subagent-Driven (recommended)** — 每个 Task 由一个独立 fresh subagent 执行，主线在 Task 间做两阶段评审（实施后验证 + 跨任务一致性回看）。本机 Windows + bash 环境最稳。

**2. Inline Execution** — 主线在本 session 内连续按 Task 顺序执行，每 4-5 个 Task 一个 checkpoint review。

用户已要求"全自动"，**默认选 1（Subagent-Driven）**。下一步：进入 `superpowers:subagent-driven-development`。
