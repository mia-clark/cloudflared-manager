# FRP Manager Docker 迁移设计 (frpmgr-server)

> 日期: 2026-05-20
> 状态: 已批准开始实施 (用户授权全程自动推进)
> 作者: Claude (基于与用户 brainstorming 的结论)

## 0. TL;DR

将原 Windows GUI 工具 `frp-manager` 改造为 **Linux 优先、Docker 友好的 headless 守护进程** `frpmgrd`,通过完整的 REST + WebSocket API 暴露原有的全部业务能力,以便后续用户自己用 React/Vue 编写 webui 直接对接。

**直接在当前仓库内改造** (用户已将原仓库本地复制一份作为新仓库的起点)。

## 1. 决策基线 (已锁定)

| 维度 | 决策 |
|---|---|
| 最终形态 | headless daemon + REST API |
| 部署粒度 | 单容器内多实例 (一个 Go 进程 + 多个 frpc goroutine) |
| 入口 | 完整 HTTP API,后续用户自己写 webui |
| 鉴权 | Bearer Token (读 env `FRPMGR_API_TOKEN`) |
| 状态推送 | WebSocket 实时推送 + 进程内 EventBus |
| 改造路径 | 直接改造当前仓库 (不再 fork 新地址) |
| Module name | 保持 `github.com/mia-clark/frp-manager-server` 不动 (减少 import diff) |
| frp 集成方式 | 作为 Go 库 (沿用 `services/client.go`) — **不调用独立 frpc 二进制** |
| 自动重启 | 每个 instance goroutine 用 `recover()` + 指数退避重试 |
| 日志方式 | 文件持久化 + WebSocket tail 订阅 |
| 连接数 metric | **放弃**(Linux 读 /proc/net/tcp 复杂度高,first version 砍掉) |

## 2. 架构总览

### 2.1 进程拓扑

```
┌──────────────────────────────────────────────────────────────┐
│                  frpmgrd  (single process)                    │
│                                                               │
│  ┌──────────────┐    ┌──────────────┐    ┌────────────────┐  │
│  │ HTTP Server  │ ←→ │   Manager    │ ←→ │   EventBus     │  │
│  │ (chi router) │    │ (instance    │    │ (in-proc       │  │
│  │              │    │  registry)   │    │  pub/sub)      │  │
│  └──────┬───────┘    └──────┬───────┘    └────────┬───────┘  │
│         │                   │                     │           │
│  ┌──────▼───────┐    ┌──────▼──────────────┐  ┌───▼──────┐   │
│  │  REST API    │    │ Instance pool       │  │ WS / SSE │   │
│  │  Bearer mw   │    │ ┌─────────────────┐ │  │ handlers │   │
│  │  CORS mw     │    │ │ FrpClientService│ │  └──────────┘   │
│  └──────────────┘    │ │ (reused as-is)  │ │                 │
│                      │ │ + LogTailer     │ │                 │
│                      │ │ + AutoDelTimer  │ │                 │
│                      │ └─────────────────┘ │                 │
│                      │   × N (per .toml)   │                 │
│                      └─────────────────────┘                 │
│                                                               │
│         /data/profiles/  /data/logs/  /data/stores/          │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 关键流转 (start a config)

```
client                  api          manager        instance         eventbus
  │ POST /start          │             │               │                │
  ├─────────────────────►│             │               │                │
  │                      │ Start(id)   │               │                │
  │                      ├────────────►│ load .toml    │                │
  │                      │             ├──────────────►│ NewFrpClient   │
  │                      │             │               ├ run goroutine ┐│
  │                      │             │               │               ││
  │                      │             │               │ statusPoller ─┤│
  │                      │             │               │               ││
  │                      │             │  state:Started│               ││
  │                      │             │◄──────────────┤◄──────────────┘│
  │  200 OK              │             │ Publish ──────┼───────────────►│
  │◄─────────────────────┤◄────────────┤               │                │
                                                                         │
WS /events  ◄──── pump ◄──────────────────────────────────────────────── │
```

## 3. 仓库结构与代码处置

> 总目标: **改造现有仓库**,而不是全新创建。保留所有跨平台代码,删除所有 Windows-only 代码,新增 daemon + API 层。

### 3.1 保留 (跨平台,直接复用)

| 路径 | 备注 |
|---|---|
| `pkg/config/` | INI/TOML 解析、frp 配置模型 — 完全跨平台 |
| `pkg/consts/` | 常量集 |
| `pkg/util/file.go` | 文件工具 |
| `pkg/util/misc.go` | 反射 / 字节 |
| `pkg/util/strings.go` | 字符串 |
| `pkg/validators/` | 正则/密码校验 |
| `pkg/version/` | 版本信息 |
| `pkg/sec/` | 密码 hash (备用) |
| `services/client.go` | `FrpClientService` — frp 库的薄封装,跨平台 |
| `services/frp.go` | `VerifyClientConfig` 静态校验 |
| `i18n/` | **保留但仅供错误码英文文案使用**;不再用于 UI |
| `CHANGELOG.md`, `LICENSE` | 保留 |

### 3.2 新增

```
cmd/frpmgrd/
  └── main.go                         # daemon 入口

internal/
  ├── api/
  │   ├── server.go                   # chi router 装配
  │   ├── middleware/
  │   │   ├── auth.go                 # Bearer
  │   │   ├── cors.go                 # CORS
  │   │   ├── logger.go               # access log
  │   │   └── recover.go              # panic
  │   ├── errors.go                   # 统一错误响应
  │   ├── configs.go                  # configs CRUD + raw TOML
  │   ├── proxies.go                  # proxies CRUD
  │   ├── lifecycle.go                # start/stop/reload
  │   ├── status.go                   # 实例 + proxy 状态
  │   ├── logs.go                     # 日志查询
  │   ├── events.go                   # WebSocket /events
  │   ├── importexport.go             # 导入/导出
  │   ├── validate.go                 # POST /validate
  │   ├── nathole.go                  # STUN
  │   └── system.go                   # /health /version
  ├── manager/
  │   ├── manager.go                  # 实例注册表
  │   ├── instance.go                 # 单实例生命周期 + recover loop
  │   ├── autodelete.go               # 自毁定时器
  │   └── meta.go                     # /data/meta.json (autoStart/sort)
  ├── eventbus/
  │   ├── bus.go                      # ring buffer + subscribers
  │   └── types.go                    # event schema
  ├── logtail/
  │   └── tailer.go                   # fsnotify + 增量读
  └── appcfg/
      └── appcfg.go                   # daemon 本身的 env 解析

deploy/
  ├── Dockerfile                      # 多阶段构建
  ├── docker-compose.yml              # 单服务示例
  ├── docker-compose.dev.yml          # 开发用 (热重载)
  └── .env.example

docs/
  ├── api/
  │   └── openapi.yaml                # OpenAPI 3.1 描述 (供前端生成 client)
  └── README-server.md                # 部署/使用文档

Makefile                              # build / test / docker
.dockerignore
```

### 3.3 删除

| 路径 | 原因 |
|---|---|
| `cmd/frpmgr/` (整目录) | Windows GUI 入口 + singleton + 资源 |
| `ui/` (整目录) | walk GUI |
| `i18n/locales/` | GUI 翻译资源 (代码保留作为错误码字典基础) |
| `icon/` | GUI 图标 |
| `installer/` | WiX MSI 打包 |
| `pkg/ipc/` | Named Pipe |
| `pkg/layout/` | GUI 布局 |
| `pkg/res/` | GUI 静态资源 |
| `pkg/util/net.go` | Win32 iphlpapi 调用 |
| `services/install.go` | Windows SCM 注册 |
| `services/service.go` | Windows svc.Execute |
| `services/tracker.go` | Windows SC_EVENT 订阅 |
| `env.go`, `generate.go`, `resource.go` | Windows 资源 generate |
| `build.bat` | 由 Makefile 替代 |
| `.golangci.yml` | 重写或保留 |

### 3.4 go.mod 瘦身

删除依赖:
- `github.com/Microsoft/go-winio` (Named Pipe)
- `github.com/lxn/walk` (replace 行也一并删除)
- `github.com/lxn/win`
- `golang.zx2c4.com/wintun` (来自 walk 的间接依赖)

新增依赖:
- `github.com/go-chi/chi/v5` (router) — 轻量、无运行时反射
- `github.com/coder/websocket` (WebSocket) — gorilla 的现代替代
- `github.com/fsnotify/fsnotify` (已有 → 用于 log tail)

`golang.org/x/sys` 仍保留 (frp 内部需要)。

## 4. REST API + WebSocket 设计

### 4.1 通用约定

- 前缀: 所有 API 路径以 `/api/v1/` 开头
- Content-Type: 默认 `application/json`;raw TOML 通道用 `application/toml`
- 鉴权: HTTP header `Authorization: Bearer <token>`;WebSocket 升级时允许 `?token=<token>` query 作 fallback
- CORS: 通过 env `FRPMGR_CORS_ORIGINS` (逗号分隔,默认 `*`)
- 错误响应统一:
  ```json
  {
    "error": {
      "code": "config_not_found",
      "message": "config 'demo' does not exist",
      "details": {}
    }
  }
  ```
- 时间: 统一 RFC3339,UTC
- ID: configID = 文件名去扩展名 (例: `profiles/demo.toml` → id=`demo`)

### 4.2 端点清单

#### 系统
- `GET  /api/v1/health` — 健康检查 (**免鉴权**),返回 `{"status":"ok","uptime_s":N}`
- `GET  /api/v1/version` — daemon + frp 版本

#### Configs
- `GET    /api/v1/configs` — 列出 + 排序 + 每个实例当前 state
- `POST   /api/v1/configs` — 新建 (JSON body)
- `GET    /api/v1/configs/{id}` — 详情
- `PUT    /api/v1/configs/{id}` — 整体替换 (JSON)
- `PATCH  /api/v1/configs/{id}` — 局部 (JSON Merge Patch)
- `DELETE /api/v1/configs/{id}` — 删除 (会先 stop)
- `POST   /api/v1/configs/{id}/duplicate` — 复制
- `GET    /api/v1/configs/{id}/raw` — 返回原始 TOML 文本
- `PUT    /api/v1/configs/{id}/raw` — 提交原始 TOML
- `POST   /api/v1/configs/reorder` — `{"order":["a","b","c"]}` 保存排序

#### Proxies
- `GET    /api/v1/configs/{id}/proxies` — 列表 + 状态
- `POST   /api/v1/configs/{id}/proxies` — 添加
- `GET    /api/v1/configs/{id}/proxies/{name}`
- `PUT    /api/v1/configs/{id}/proxies/{name}`
- `DELETE /api/v1/configs/{id}/proxies/{name}`
- `POST   /api/v1/configs/{id}/proxies/{name}/toggle` — enable/disable

#### Lifecycle
- `POST  /api/v1/configs/{id}/start`
- `POST  /api/v1/configs/{id}/stop`
- `POST  /api/v1/configs/{id}/reload`
- `GET   /api/v1/configs/{id}/status` — 快照

#### Logs
- `GET    /api/v1/configs/{id}/logs?lines=200&offset=N` — 分页查询
- `GET    /api/v1/configs/{id}/logs/files` — 历史文件列表
- `DELETE /api/v1/configs/{id}/logs` — 清空

#### Validate
- `POST  /api/v1/validate` — 校验任意 JSON/TOML 配置,不落盘

#### Import / Export
- `POST  /api/v1/import/file` (multipart `file`)
- `POST  /api/v1/import/url`  (JSON `{"url":"https://..."}`)
- `POST  /api/v1/import/text` (JSON `{"text":"...","format":"toml"}`)
- `POST  /api/v1/import/zip`  (multipart `file`,ZIP 备份)
- `GET   /api/v1/configs/{id}/export` — 单文件下载
- `GET   /api/v1/export/all` — ZIP 备份 (含所有 profiles + meta)

#### NAT hole
- `POST  /api/v1/nathole/discover` — `{"stun_server":"..."}` → 返回 NAT 类型 / 外部地址

#### WebSocket
- `GET  /api/v1/events` (升级为 WS) — 全局事件流
- `GET  /api/v1/configs/{id}/logs/tail` (升级为 WS) — 实时日志

### 4.3 事件 schema

```json
{
  "type": "instance.state",
  "config_id": "demo",
  "ts": "2026-05-20T12:00:00Z",
  "seq": 12345,
  "data": { "state": "started", "prev_state": "stopped" }
}
```

事件类型:
- `instance.state` — Started/Stopped/Starting/Stopping
- `instance.error` — 运行时错误(panic + recover 触发)
- `proxy.status` — 单个 proxy 状态变更
- `config.changed` — 配置文件被修改(API 或外部 fsnotify)
- `log.line` — 实时日志行(仅 `/logs/tail` 端点推送)

订阅端可发 `{"action":"subscribe","types":["proxy.status"]}` 过滤。默认全订阅。

### 4.4 配置 JSON Schema (示例)

```json
{
  "id": "demo",
  "name": "Demo Tunnel",
  "manual_start": false,
  "auto_delete": null,
  "server": {
    "addr": "frps.example.com",
    "port": 7000,
    "protocol": "tcp"
  },
  "auth": {
    "method": "token",
    "token": "***"
  },
  "tls": { "enable": true },
  "log": { "level": "info", "max_days": 3 },
  "proxies": [
    {
      "name": "web",
      "type": "http",
      "local_ip": "127.0.0.1",
      "local_port": "8080",
      "custom_domains": "demo.example.com",
      "disabled": false
    }
  ]
}
```

后端通过 `pkg/config` 现有的 V1 ↔ Go 结构 ↔ TOML 转换链路完成 JSON ↔ TOML 双向序列化。

## 5. 进程模型与状态存储

### 5.1 文件布局 (容器内)

```
/data/
  ├── profiles/           # *.toml (持久化)
  ├── logs/               # <id>.log + <id>.YYYYMMDD-HHMMSS.log
  ├── stores/             # visitor 状态(frp 自有 store 机制)
  ├── meta.json           # daemon 元数据
  └── app.json            # daemon 用户偏好(可选,如默认值)
```

`meta.json` 结构:
```json
{
  "version": 1,
  "auto_start": ["demo", "another"],
  "sort": ["demo", "another", "third"]
}
```

### 5.2 启停流程

**Start**:
1. 从 `/data/profiles/{id}.toml` 读 → `config.UnmarshalClientConf`
2. `services.NewFrpClientService(path)`
3. Manager 起一个 goroutine 跑 `svc.Run()`,外层 `recover()` 包裹
4. 起一个 statusPoller goroutine (200ms 周期),diff 后通过 EventBus 推送
5. 如配置带 AutoDelete → 起 `time.AfterFunc` 定时器
6. 写 `meta.json` 的 `auto_start` 列表
7. EventBus 发 `instance.state=started`

**Stop**:
1. cancel context
2. `svc.Stop(false)` 直接 close
3. 等 `svc.Done()` 关闭
4. 摘除 statusPoller / autodelete timer
5. EventBus 发 `instance.state=stopped`

**Reload**:
1. 重新读 TOML
2. `svc.Reload()` 内部已经支持热替换 (沿用现有 `Reload` 方法)
3. EventBus 发 `config.changed`

**Crash 恢复** (panic):
- 捕获 → log + EventBus 发 `instance.error`
- 指数退避 (1s, 2s, 4s, 8s, 16s, max 60s),最多 5 次
- 仍失败 → state=stopped,等待人工介入

### 5.3 启动时恢复

daemon 启动时:
1. 扫描 `/data/profiles/*.toml`
2. 读 `meta.json` 的 `auto_start` 列表
3. 对每个 auto_start config → 调 Start

## 6. Docker 打包

### 6.1 Dockerfile (多阶段)

```dockerfile
# syntax=docker/dockerfile:1.7
FROM golang:1.25-alpine AS build
WORKDIR /src
RUN apk add --no-cache git ca-certificates tzdata
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=dev
ARG BUILD_DATE
RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags="-s -w -X github.com/mia-clark/frp-manager-server/pkg/version.Number=${VERSION} -X github.com/mia-clark/frp-manager-server/pkg/version.BuildDate=${BUILD_DATE}" \
    -o /out/frpmgrd ./cmd/frpmgrd

FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/frpmgrd /usr/local/bin/frpmgrd
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /usr/share/zoneinfo /usr/share/zoneinfo
ENV FRPMGR_DATA_DIR=/data \
    FRPMGR_HTTP_ADDR=:8080 \
    FRPMGR_LOG_LEVEL=info
EXPOSE 8080
VOLUME ["/data"]
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/frpmgrd"]
CMD ["serve"]
```

### 6.2 docker-compose.yml

```yaml
services:
  frpmgrd:
    build:
      context: ..
      dockerfile: deploy/Dockerfile
    image: frpmgr-server:latest
    container_name: frpmgrd
    restart: unless-stopped
    # 强烈建议 host 网络: frpc 出站 + xtcp + STUN 工作正常
    network_mode: host
    environment:
      FRPMGR_API_TOKEN: ${FRPMGR_API_TOKEN:?api token required}
      FRPMGR_HTTP_ADDR: ":8080"
      FRPMGR_CORS_ORIGINS: "*"
      FRPMGR_LOG_LEVEL: info
    volumes:
      - ./data:/data
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/api/v1/health"]
      interval: 30s
      timeout: 5s
      retries: 3
```

### 6.3 .env.example

```
FRPMGR_API_TOKEN=change-me-to-a-long-random-string
```

## 7. 业务功能迁移映射

| 现有 GUI 功能 | 新 API/方案 |
|---|---|
| 列表 / 新建 / 编辑 / 删除 config | `/configs` CRUD |
| 启停 / 热重载 | `/configs/{id}/{start,stop,reload}` |
| Proxy 编辑 | `/configs/{id}/proxies` CRUD |
| 状态跟踪 (proxy 颜色/连接数) | `GET /status` + WS `events` |
| 日志页 | `GET /logs` + WS `/logs/tail` |
| 配置文件导入 (本地/剪贴板/URL) | `/import/{file,text,url}` |
| ZIP 备份 / 还原 | `/export/all` + `/import/zip` |
| 自毁配置 | `auto_delete` 字段 → Manager 内 `time.Timer` |
| NAT hole 检测 | `/nathole/discover` |
| 多语言 | API 返回 error code,前端 i18n |
| 密码保护 | Bearer Token (`FRPMGR_API_TOKEN`) |
| 开机自启 | `meta.json/auto_start` |
| 配置排序 | `/configs/reorder` |
| 检查更新 | **不实现** (容器场景下用 `docker pull`) |

## 8. 不迁移的部分 (明确放弃)

- walk GUI、托盘图标、单例锁、Windows 服务、SCM、Named Pipe、注册表、TCP/UDP 连接计数面板、自动更新检查、WiX MSI、签名、Windows-only 路径处理
- i18n 用户界面文案(只保留错误码字典作为响应消息)

## 9. 测试策略

- 单元测试: pkg/* 已有的 *_test.go 保留 + 给 internal/eventbus、internal/manager 加测试
- 集成测试: 构建本地 frps + 启 daemon + 跑端到端 API 测试(可放到 CI)
- 健康检查: container healthcheck 走 `/api/v1/health`
- 编译验证: `make build` 必须无错误 (CI 守门)

## 10. 里程碑 / 实施阶段

| M | 目标 | 完成判据 |
|---|---|---|
| M1 | 项目脚手架: 删除 Windows 代码,go.mod 瘦身,cmd/frpmgrd 骨架可运行 | `go build ./...` 通过;`./frpmgrd serve` 启动并响应 `/health` |
| M2 | Manager + Configs CRUD + Lifecycle (no event push) | 通过 curl 完整跑通 config CRUD + start/stop/reload |
| M3 | EventBus + WebSocket `/events` + LogTailer + `/logs/tail` | wscat 看到 instance.state + log.line 推送 |
| M4 | Import/Export + Validate + AutoDelete + nathole | 上传 zip 还原配置;auto_delete 到期自动清理 |
| M5 | Dockerfile + compose + healthcheck + docs/api/openapi.yaml | `docker compose up` 后跑通端到端用例;OpenAPI 可生成前端 client |
| M6 | 系统/容器 metrics + per-proxy 连接数 | `GET /api/v1/system/info` 一次返回 host/cpu/mem/disk/net/conns/process;proxy snapshot 含 `cur_conns`;WS 推 `proxy.connections` 事件 |

### M6 详解(后续增补,2026-05-20)

用户反馈"流量/连接数 metric 必须要,容器里读 /proc 没问题"。增量改造:

**新依赖**:
- `github.com/shirou/gopsutil/v4` — 跨平台拿 CPU/内存/磁盘/网络
- `/proc/net/tcp{,6}` 直读 — per-LocalPort 连接计数(Linux),build tag 隔离

**新代码**:
- `internal/sysinfo/` — gopsutil 薄封装,7 个函数对应 7 个端点
- `internal/conntrack/` — `Get([]uint16) → map[port]int`,Linux 真读,其他平台返 0
- `internal/api/system.go` — 新增 6 个 GET 端点 + 1 个聚合 `/system/info`
- `internal/manager/instance.go` — statusPoller 增加 2 秒一次的 `refreshConnCounts`,diff 后 publish `proxy.connections` 事件
- `internal/eventbus/types.go` — 新增 `TypeProxyConnections` + `ProxyConnectionsData`

**重要架构决策 — per-proxy 字节流量明确不做**:

调查 `github.com/fatedier/frp@v0.68.1/client/proxy/proxy_wrapper.go:53` 的 `WorkingStatus` 结构,客户端只暴露 `Name/Type/Phase/Err/RemoteAddr`,**没有任何字节/连接计数字段**。流量统计是 frps 服务端职责(`server/proxy/`)。要在客户端拿,只有两条路:

1. fork frp,给 wrapper 包装一层 net.Conn 计数 — 工程量巨大且后续 frp 升级要持续 maintain
2. 启用每个 frpc 的 admin API 并由 daemon 反代查询 — frp 自己的 admin API 也只暴露 status,不暴露 traffic

所以**这是 frp 客户端架构本身的限制**,本项目接受现状:
- 客户端可拿:`cur_conns`(我们自己读 `/proc/net/tcp` 拿到)、容器整体收发字节(`/proc/net/dev`)
- per-proxy 字节流量:文档明确指引用户在 frps 端 dashboard 查

## 11. 风险与对策

| 风险 | 缓解 |
|---|---|
| frp 库内 panic 拖死整个 daemon | 每个 goroutine `recover()` + 重启 + 上报事件 |
| 单容器 N 个实例共享 systemd-less 生命周期 | daemon 监听 SIGTERM → 优雅停所有 instance |
| host 网络下端口冲突 | 文档明确说明,建议生产环境用 bridge 网络 + 显式 port mapping(代价: xtcp 可能受限) |
| 配置文件并发写 | Manager 内对 `/data/profiles` 加 sync.RWMutex,所有写走原子 rename |
| WebSocket 连接泄漏 | 每个 subscriber 设 5min 心跳;无心跳 → 自动断开 |

## 12. 与上游 FRP 升级的同步策略

go.mod 锁定 `github.com/fatedier/frp v0.68.1` (沿用现版本)。后续升级:
- 监控上游 release
- 在 dev 分支 bump version → 跑全部 *_test.go + 集成 e2e → tag release
- 对外 docker image tag 用 `frpmgr-server:<frpmgr-ver>-frp<frp-ver>` 双版本号

## 13. 实施备注

- 模块名保持 `github.com/mia-clark/frp-manager-server` 不动(减少 import 改写量)
- 提交规范: 按 M1~M5 分阶段提交,每阶段结束打 tag
- 文档: 每个 milestone 完成时同步更新 README-server.md
