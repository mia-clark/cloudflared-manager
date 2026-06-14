# cloudflared 二进制全自动更新 — 设计文档

> 日期：2026-06-14 · 状态：已批准（用户拍板「全部按推荐」）
> 目标：让面板**一般不需要人工管理 cloudflared 二进制**——启动自举、定时检查、自动下载校验、激活并滚动重启实例，失败自动回滚；同时保留完整手动干预入口。

---

## 1. 背景与现状

`internal/cfdbin` 已具备：幂等下载（`Store.Install`）、SHA256 校验、多代理故障转移、多版本 store、`active.json` 当前版本、`Resolve/Activate/List/Delete`。但**没有**任何「启动自举」与「定时调度」逻辑——`main.go` 启动时不下载二进制，也无周期性检查。

实例启动时经 `binStore.Resolve(cfg.BinaryVersion)` 选二进制：`binaryVersion` 为空 / `current` → 跟随 `active.json`；否则用钉死版本。**换了 active 版本必须重启实例才生效。**

可借鉴范式：`metrics.Sampler.Run` 的定时 goroutine、`selfupdate.CompareVersions/HasUpdate` 的版本比较、`Settings.tsx` + `meta.json`(Branding) 的设置持久化、`eventbus` 的事件推送。

## 2. 三项已决策（用户拍板）

1. **默认全自动**：定时检查→下载→激活→滚动重启所有跟随实例，零干预；**同时保留**手动「立即检查 / 强制更新到指定版本 / 立即应用」。
2. **环境变量 + 面板设置页双控**：env 设默认、UI 运行时覆盖并即时生效、持久化到 `meta.json`。
3. **滚动重启 + 失败自动回滚**：逐个实例重启并健康探测；新版导致实例起不来则把 active 回滚到上一可用版本并把已动过的实例全部重启回旧版，保留新二进制供排查。

## 3. 架构选型

新建独立包 **`internal/cfdupdate`**（自成体系的定时组件，仿 `metrics.Sampler`），在 `main.go` 装配。单向依赖：`cfdbin`（下载/激活/清理）+ `manager`（重启实例、读写设置）+ `eventbus`（进度推送）。`manager` **不**反向依赖 `cfdupdate`（无循环）。

## 4. 组件与文件

| 文件 | 职责 |
|---|---|
| `internal/cfdupdate/settings.go` | `Settings` 模型 + env 默认加载 + 校验/归一 |
| `internal/cfdupdate/updater.go` | 核心引擎：`Run(ctx)` 定时循环 + `CheckAndApply` + 滚动重启/回滚 + retention + `runMu` + 状态快照 + 事件 |
| `internal/cfdupdate/updater_test.go` | 单测（fake manager/downloader 注入） |
| `internal/cfdbin/download.go` | 新增 `Downloader.ResolveLatest(ctx, includePrerelease) (tag, error)` |
| `internal/eventbus/types.go` | 新增 `TypeBinaryUpdate = "binary.update"` + `BinaryUpdateData` |
| `internal/manager/meta.go` + `manager.go` | `meta.json` 增 `auto_update` 块 + getter/setter；新增 `ActiveFollowerRunningIDs()` / `WaitHealthy(id,grace)` / `ReloadInstance` 复用 |
| `internal/api/autoupdate.go` | `GET/PUT /binaries/auto-update`、`POST /binaries/auto-update/run` |
| `internal/api/server.go` + `cmd/cfdmgrd/main.go` | 装配 + 启动自举 + `go Run` |
| 前端 `api/{types,client}.ts`、`pages/{Settings,Binaries}.tsx`、`events/types.ts` | 双控 UI + 事件订阅 |

## 5. 设置模型（`meta.json` 的 `auto_update` 块，外层 snake_case）

| 字段 | 类型 | 默认 | env | 含义 |
|---|---|---|---|---|
| `enabled` | bool | `true` | `CFDM_CFD_AUTOUPDATE_ENABLED` | 总开关 |
| `mode` | string | `full` | `CFDM_CFD_AUTOUPDATE_MODE` | `full`/`download`/`notify` |
| `interval_hours` | int | `24` | `CFDM_CFD_AUTOUPDATE_INTERVAL_HOURS` | 检查周期（夹取 [1,720]） |
| `include_prerelease` | bool | `false` | `CFDM_CFD_AUTOUPDATE_PRERELEASE` | 收预发布版 |
| `auto_rollback` | bool | `true` | `CFDM_CFD_AUTOUPDATE_ROLLBACK` | 失败自动回滚 |
| `keep_versions` | int | `3` | `CFDM_CFD_AUTOUPDATE_KEEP` | 保留最近 N 版（0=不清理，夹取 [0,50]） |
| `health_grace_seconds` | int | `8` | `CFDM_CFD_AUTOUPDATE_HEALTH_GRACE` | 重启后健康观察窗口（夹取 [1,120]） |

优先级：**UI 持久化值 > env 默认**。首次（`meta.auto_update == nil`）以 env/内置默认初始化并落盘。`Settings` 的 env 默认仅在进程内构造一次注入 updater，作为「`meta` 未设置时的兜底」；一旦 UI 写过即以 `meta` 为准。

## 6. 状态与事件

### 6.1 运行状态快照（`updater.Status()`，供 `GET` 返回）
```
state:          idle | checking | downloading | applying | restarting | rolling_back
last_result:    up_to_date | updated | downloaded | notified | failed | rolled_back | ""
last_error:     string
last_check_at:  RFC3339（unix 秒或时间字符串）
active_version: string（store 当前 active）
latest_known:   string（最近一次检查到的 latest tag）
pending_version:string（download 模式下已下载待应用的版本）
in_progress:    bool
```

### 6.2 事件 `binary.update`（单一类型 + `data.phase` 区分）
`data`：`{ phase, version?, from?, to?, instance_id?, message?, error? }`
phase ∈ `checking | up_to_date | available | downloading | downloaded | applying | restarting | done | rolled_back | error`。前端订阅即可实时刷新状态条与设置卡片。

## 7. 核心流程 `CheckAndApply(ctx, opts)`

`opts`：`{ Version string; Force bool; Apply bool }`（手动触发用；定时触发为零值）。

抢 `runMu`（拿不到 → 返回 `ErrBusy`，API 映射 409）。步骤：

1. **checking**：`target := opts.Version`；为空则 `downloader.ResolveLatest(ctx, settings.IncludePrerelease)`。记 `latest_known`、`last_check_at`。
2. **比较**：`active := store.ActiveVersion()`。若 `target` 非空且 `CompareVersions(active, target) >= 0` 且 `!opts.Force` → `last_result=up_to_date`，发 `up_to_date` 事件，结束。
3. **downloading**：`store.Install(ctx, downloader, target)`（幂等+校验）。失败 → `last_result=failed` + `error` 事件，**不动现网**，结束。发 `downloaded` 事件。
4. **mode 分叉**：
   - `notify` 且非 `opts.Apply` → `last_result=notified` + `available` 事件，结束（不激活）。
   - `download` 且非 `opts.Apply` → `pending_version=target` + `last_result=downloaded`，结束（不激活）。
   - `full` 或 `opts.Apply` → 进入 applying。
5. **applying**：`prev := store.ActiveVersion()`；`store.Activate(target)`。若 `prev == target` 且 `!opts.Force`（已是该版本）→ 仍需确保实例在跑该版本？正常步骤 2 已挡掉；force 重装时 prev==target 则回滚目标为空，跳过回滚逻辑。
6. **restarting（滚动 + 回滚）**：
   - `ids := manager.ActiveFollowerRunningIDs()`（运行中且 `binaryVersion` ∈ {"","current"} 的实例；**显式钉版实例不动**）。
   - 逐个：发 `restarting{instance_id}` → `manager.Reload(id)` → `manager.WaitHealthy(id, grace)`。
   - 成功累加到 `restarted`；**任一失败**且 `auto_rollback`：进入 `rolling_back` → `store.Activate(prev)` → 对 `restarted + 当前失败 id` 全部 `Reload`（回旧版）→ `last_result=rolled_back` + `rolled_back` 事件 → 结束（判失败，保留新二进制不删）。
   - `auto_rollback=false` 时：记录失败、继续其余实例（尽力而为），`last_result=failed`。
7. **retention**：成功路径末尾，`pruneOld(keep_versions)`：`store.List()` 按版本降序，跳过 active 与「当前被某运行实例钉用的版本」，保留前 keep 个，其余 `store.Delete`。`keep_versions==0` 跳过。
8. `last_result=updated` + `done` 事件。

并发：定时与手动共用 `CheckAndApply`，`runMu` 串行化。

## 8. 启动自举（`main.go`）

在 `mgr.LoadAll()` 之后、`mgr.AutoStart()` **之前**：
- 构造 `updater`（注入 settings/env 默认 + store + downloader + manager + bus + logger）。
- 若 `settings.Enabled` 且 `store.ActiveVersion() == ""`（无任何 active 二进制）→ **同步**执行一次「下载+激活 latest」（带 ~3min 超时；失败仅 `logger.Warn` 不致命，AutoStart 自然回退 PATH）。覆盖「启动判断本地有无二进制，无则下载」。
- `mgr.AutoStart()`。
- `go updater.Run(ctx)`：首 tick 延迟 30s（让面板先就绪），随后每 `interval` 一次；首跑即触发一次 `CheckAndApply`（定时触发）。覆盖「启动判断是否需要更新」。

> 自举若刚激活 latest，AutoStart 实例自然用新版无需重启；之后定时 Run 发现已最新即 `up_to_date`。

## 9. HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/binaries/auto-update` | 返回 `{ settings, status }` |
| PUT | `/api/v1/binaries/auto-update` | 改 settings（部分字段，DisallowUnknownFields），即时生效（重置 ticker），返回新 `{settings,status}` |
| POST | `/api/v1/binaries/auto-update/run` | body `{version?, apply?, force?}`，异步触发一次 `CheckAndApply`，返回 202 `{status:"running"}`；忙时 409 |

既有 `GET/POST/DELETE /api/v1/binaries*`（手动 install/activate/delete）**全部保留**。`Deps` 增 `BinaryUpdater *cfdupdate.Updater`（nil 时这三个端点 503 降级）。

## 10. manager 新增方法

- `ActiveFollowerRunningIDs() []string`：遍历运行中实例，读其磁盘 YAML 的 `binaryVersion`，空/`current` 才纳入（按 meta 排序）。
- `WaitHealthy(id string, grace time.Duration) bool`：在 grace 内轮询；要求始终保持 `started` 且 `lastErr==""`；中途变 `stopped`/有错即返回 false。
- 设置读写：`AutoUpdateRaw() *AutoUpdateSettings` / `SetAutoUpdate(s) error`（存 `meta.json`，类型用 `map[string]any` 或具名结构——选具名 `AutoUpdateMeta` 与 cfdupdate.Settings 字段一致，避免循环依赖：meta 里定义独立结构，cfdupdate 负责转换）。

> 为避免 `manager` 反依赖 `cfdupdate`：`meta.go` 定义 `AutoUpdateMeta`（纯数据），cfdupdate 定义 `Settings` 并提供 `FromMeta/ToMeta`。manager 仅持久化 `AutoUpdateMeta`。

## 11. 前端

- `events/types.ts`：`EventType` 加 `'binary.update'`；加 `BinaryUpdateData` 接口。
- `api/types.ts`：`AutoUpdateSettings` / `AutoUpdateStatus` / `AutoUpdateView`。
- `api/client.ts`：`autoUpdateApi.get/update/run`。
- `pages/Settings.tsx`：新增「cloudflared 二进制自动更新」卡片——开关、模式 Select、间隔 InputNumber、保留版本数、含预发布开关、自动回滚开关；「立即检查更新」按钮；展示 last check / active / latest / state。订阅 `binary.update` 即时刷新。
- `pages/Binaries.tsx`：顶部加自动更新状态条 + 「立即检查更新」「强制更新到最新」按钮；订阅 `binary.update` 自动 `loadList()`。
- 严格遵守 `web-api-binding`（外层 snake_case 契约）。

## 12. 测试

- `cfdupdate`：版本比较/选版、mode 三分叉、滚动重启**成功**、失败**回滚**、`auto_rollback=false` 尽力而为、retention 清理（含跳过 active/钉用版本）、`runMu` 并发忙时 `ErrBusy`、`Settings` env 默认与夹取。用可注入接口（`releaseSource` / `instanceController`）+ 内存 fake。
- `manager`：`ActiveFollowerRunningIDs`（含钉版排除）、`WaitHealthy`（健康/早退两路）、`AutoUpdate` 读写往返。
- Windows 注意：运行中二进制不可删——retention 永不删 active；删除非 active 旧版即可。

## 13. 文档同步

- `internal/api/openapi.yaml`：新增 3 个端点 + schema。
- `docs/API.zh-CN.md`：新增「二进制自动更新」节（字段表）。
- `CLAUDE.md` §7 环境变量表：补 `CFDM_CFD_AUTOUPDATE_*` 七项。

## 14. 验证口径

后端 `make test` + `go vet`；前端 `npm run build`（`tsc -b && vite build`）；最后 `make build-host` 打主机二进制。全绿后提交、推送分支、开 PR。

## 15. 非目标（YAGNI）

- 维护窗口/灰度时段调度（v1 用滚动重启把影响降到最低即可）。
- 多通道（stable/beta）切换（仅 `include_prerelease` 布尔）。
- 二进制级别的签名验证（已有 SHA256；上游无 GPG 签名经代理透出）。
