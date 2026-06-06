# FRP Manager → frpmgr-server 实施计划

> 配套设计: `docs/superpowers/specs/2026-05-20-frpmgr-docker-migration-design.md`
> 执行模式: 全程自动 (用户授权,无人值守)
> 推进策略: 主 agent 串行守门 + 关键 milestone 内独立任务并行下放 subagent

## 执行原则

1. **每个 milestone 完成后必跑** `go build ./...`,失败必须修到通过再进入下一阶段
2. **不修改 frp 库本身** — 所有兼容性问题由我方 wrapper 吸收
3. **Windows shell 兼容**: 不使用 `&&` 链接、不写 BOM、Bash 工具用 Unix 语法
4. **删除策略**: 旧 Windows 文件直接 `rm`,不留 `_deprecated.go`、不留 build-tag 占位
5. **每个 milestone tag commit**: `m1-skeleton`, `m2-crud`, `m3-realtime`, `m4-features`, `m5-docker`(由用户在合适时机推送,我不主动 push)

---

## M1 — 项目脚手架 (零业务,只让 daemon 起来)

**目标**: `go build ./cmd/frpmgrd` 通过;`./frpmgrd serve` 返回 `/health`

### 任务 (可分两批并行)

#### 批次 A — 清理 (并行)
- [ ] A1: 删除 `cmd/frpmgr/`、`ui/`、`installer/`、`icon/` 整目录
- [ ] A2: 删除 `pkg/ipc/`、`pkg/layout/`、`pkg/res/`、`i18n/locales/`
- [ ] A3: 删除 `services/install.go`、`services/service.go`、`services/tracker.go`
- [ ] A4: 删除 `pkg/util/net.go`
- [ ] A5: 删除 `env.go`、`generate.go`、`resource.go`、`build.bat`

#### 批次 B — go.mod 瘦身 (依赖批次 A 完成)
- [ ] B1: 修改 `go.mod` — 删 `Microsoft/go-winio`、`lxn/walk`、`lxn/win` 及 replace
- [ ] B2: 添加 `github.com/go-chi/chi/v5`、`github.com/coder/websocket`
- [ ] B3: `go mod tidy` 验证

#### 批次 C — 新建骨架 (依赖批次 B)
- [ ] C1: 创建 `cmd/frpmgrd/main.go` — 含 `serve` 子命令、env 解析
- [ ] C2: 创建 `internal/appcfg/appcfg.go` — env 配置结构
- [ ] C3: 创建 `internal/api/server.go` — chi router + 中间件装配
- [ ] C4: 创建 `internal/api/middleware/{auth,cors,logger,recover}.go`
- [ ] C5: 创建 `internal/api/errors.go` — 统一错误响应
- [ ] C6: 创建 `internal/api/system.go` — `/health`、`/version`
- [ ] C7: 创建 `Makefile`、`.dockerignore`、`.gitignore` 更新

#### 验证
- [ ] V1: `go build ./...` 通过
- [ ] V2: `go vet ./...` 通过
- [ ] V3: `./frpmgrd serve` 启动 + `curl -H "Authorization: Bearer dev" :8080/api/v1/health` 返回 200

---

## M2 — Manager + Configs CRUD + Lifecycle

**目标**: 完整的 config CRUD + 启停 + 热重载,无事件推送

### 任务

#### 批次 A — Manager 内核 (串行)
- [ ] A1: `internal/manager/instance.go` — Instance struct + recover loop + statusPoller
- [ ] A2: `internal/manager/manager.go` — 注册表 + 启停 API + profiles dir 扫描
- [ ] A3: `internal/manager/meta.go` — `meta.json` 读写

#### 批次 B — HTTP handlers (依赖 A,组内可并行)
- [ ] B1: `internal/api/configs.go` — CRUD + raw TOML + reorder + duplicate
- [ ] B2: `internal/api/proxies.go` — CRUD + toggle
- [ ] B3: `internal/api/lifecycle.go` — start/stop/reload
- [ ] B4: `internal/api/status.go` — `/status`
- [ ] B5: `internal/api/validate.go` — `/validate`

#### 批次 C — JSON ↔ TOML 序列化
- [ ] C1: 检查 `pkg/config/v1.go` 是否能直接用于 JSON 输出
- [ ] C2: 必要时在 `pkg/config/` 加 JSON-friendly tag 或 wrapper

#### 验证
- [ ] V1: `go build ./...` + `go vet ./...` 通过
- [ ] V2: curl 跑完整 CRUD 用例 (新建→修改→启动→reload→停→删)

---

## M3 — EventBus + WebSocket + LogTailer

**目标**: 客户端 WS 订阅能看到 state + log.line 推送

### 任务

#### 批次 A — EventBus (串行)
- [ ] A1: `internal/eventbus/types.go` — Event struct + 类型常量
- [ ] A2: `internal/eventbus/bus.go` — ring buffer (cap=1024) + subscribers + Publish/Subscribe

#### 批次 B — WebSocket handlers (依赖 A)
- [ ] B1: `internal/api/events.go` — `/events` 升级 + 订阅过滤
- [ ] B2: `internal/api/logs.go` — `/logs` 查询 + `/logs/tail` WS

#### 批次 C — LogTailer (并行 B)
- [ ] C1: `internal/logtail/tailer.go` — fsnotify + 增量读 + 多订阅者 fan-out

#### 批次 D — Manager 接入 EventBus (依赖 A)
- [ ] D1: instance.go 状态变更发 `instance.state` 事件
- [ ] D2: statusPoller diff 后发 `proxy.status` 事件
- [ ] D3: recover loop 发 `instance.error` 事件

#### 验证
- [ ] V1: `wscat -c "ws://localhost:8080/api/v1/events?token=dev"` 看到 state 事件
- [ ] V2: `/logs/tail` WS 看到日志行实时推送
- [ ] V3: kill frp 后看到 `instance.error` + 自动重启事件

---

## M4 — Import/Export + Validate + AutoDelete + nathole

**目标**: 业务能力补齐

### 任务

- [ ] T1: `internal/api/importexport.go` — file/url/text/zip 导入 + 单/zip 导出
- [ ] T2: `internal/manager/autodelete.go` — `time.AfterFunc` + 到期清理 + meta.json 同步
- [ ] T3: `internal/api/nathole.go` — STUN 检测 (复用 frp `pkg/nathole` 或裸 stun lib)
- [ ] T4: 完善 `/validate` 端点
- [ ] T5: 写 `docs/api/openapi.yaml` (OpenAPI 3.1)

#### 验证
- [ ] V1: 上传一个 zip → 还原 → 启动通过
- [ ] V2: 设 autoDelete 30s → 30s 后自动 stop + 删文件 + 发事件
- [ ] V3: OpenAPI 通过 https://editor.swagger.io 校验

---

## M5 — Docker 打包 + 文档

**目标**: `docker compose up` 跑通端到端

### 任务

- [ ] T1: `deploy/Dockerfile` (多阶段 + distroless)
- [ ] T2: `deploy/docker-compose.yml` + `.env.example`
- [ ] T3: `deploy/docker-compose.dev.yml` (dev: 挂载代码 + 热重载用 air)
- [ ] T4: `docs/README-server.md` — 部署/配置/API 速查
- [ ] T5: 根目录 README.md 改写 (从 GUI 介绍切换到 daemon 介绍)
- [ ] T6: CHANGELOG.md 加 `[Unreleased]` 节标注架构变更

#### 验证
- [ ] V1: 本地 `docker build` 通过 (用户在有 docker 的机器上执行)
- [ ] V2: `docker compose up -d` + healthcheck 通过
- [ ] V3: 端到端 e2e 脚本 (`scripts/e2e.sh`) 跑通

---

## 任务派发模式

- **批次内独立任务** → 用 Agent + Explore/general-purpose 并行
- **批次间有依赖** → 主 agent 串行守门 + 验证编译
- **每个 milestone 结束** → 主 agent 跑 `go build`、`go vet`、单测
- **异常处理**:
  - 编译失败 → 主 agent 直接 fix(不再下放)
  - 设计冲突 → 主 agent 自主决策,在 spec 上加 ADR 段
  - 上游 frp 库版本兼容问题 → 锁定当前 v0.68.1,不升级
