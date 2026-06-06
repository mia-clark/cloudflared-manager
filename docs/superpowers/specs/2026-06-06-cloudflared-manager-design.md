# cloudflared-manager 设计规约（spec）

> 作者：Claude（在 mia-clark 的 superpowers 流程中产出）
> 起草日期：2026-06-06
> 状态：草案 v1（等待用户终审 → 转 writing-plans）
> 调研工件：`docs/superpowers/specs/raw/2026-06-06-research.json`（6 维并行调研结果，可附档）
> 现状基线：本仓库当前是 `frps-manager`（cmd/frpsmgrd + 内嵌 `fatedier/frp`），目录已改名为 `cloudflared-manager`，业务代码尚未替换。

---

## §0. 目标与非目标

### 0.1 项目目标（要做什么）

把现有的 **frps 多实例管理面板**整体改造为 **cloudflared 多实例管理面板**：

1. **单守护进程 + N 个 cloudflared 子进程**：一个 Go 守护 `cfdmgrd` 同时托管多个 cloudflared tunnel 连接器（每个 tunnel 对应一个独立子进程）。
2. **token 模式（remote-managed）**：每个实例的 ingress、public hostname、origin 配置都在 Cloudflare Zero Trust dashboard 里管理；本面板**只管"连接器进程"**：跑、停、看日志、看连接、看指标、看健康。
3. **图形化配置上游 cfd 参数**：把 cloudflared 连接器一侧的可调 flag（约 12 个核心 + 高级覆盖）用表单暴露，并支持 YAML 文件双向编辑。
4. **多实例日志**：实时查看 / 历史回看 / 过滤 / 下载 每个实例的 cloudflared 日志。
5. **多实例指标与告警**：拉取每个实例 `--metrics` 端口、写 SQLite 时序、画曲线、按阈值告警（支持 webhook）。
6. **cloudflared 二进制托管**：面板自带一份 cloudflared 二进制，并提供 UI"检查更新 / 下载新版 / 多版本并存 / 实例可绑特定版本 / 一键回滚"。
7. **运维体验对齐**：保留 frps-manager 现有的安装脚本（systemd / launchd / OpenRC / Windows 服务）、单二进制交付、Docker 镜像、`fms` → `cfm` 统一管理命令、面板自升级。
8. **加密备份**：导出/导入所有实例配置 + token 为加密 ZIP（用户提供 passphrase 派生密钥 AES-GCM）。

### 0.2 非目标（明确不做）

| 不做 | 理由 |
|---|---|
| 在面板里 CRUD Cloudflare 上的 tunnel / route / DNS | 不集成 Cloudflare API；面板就是个**纯进程管家**；建/改/删 tunnel 自行去 Cloudflare Zero Trust dashboard |
| 本地 ingress 规则图形化 | 在 token 模式下，ingress 由 CF 边缘下发，面板不可触达 |
| Named Tunnel（local-managed，config.yml + cert.pem） | 仅支持 token 模式，简化心智 |
| Quick Tunnel（trycloudflare.com 临时随机域名） | 无管理价值 |
| `cloudflared access` / `proxy-dns` 等其它子命令 | 不在范围 |
| 内嵌 cloudflared 作为 Go 库 | 官方明确反对；改用外部二进制 + 子进程模型 |
| frps 模式（同时管 frps + cloudflared） | 一次性 fork 重命名，不保留 driver 抽象，frps 代码全删 |
| Bearer 之外的鉴权（OAuth / OIDC / mTLS） | 沿用现有 API token 即可，过度复杂 |

### 0.3 取舍清单（来自澄清阶段，已锁定）

| 编号 | 决策 | 取值 |
|---|---|---|
| D1 | 使用模式 | 仅 cloudflared token 模式 |
| D2 | Cloudflare API 集成 | 不集成 |
| D3 | cloudflared 二进制 | 面板自带 + UI 升级 / 多版本并存 |
| D4 | 改造路径 | 一次性 fork 重命名 + 业务层纯替换；移除 `fatedier/frp` |
| D5 | 必含特性 | 实时日志 / CLI flag 图形化 / 配置文件双向编辑 / 多实例 / 自启动 |
| D6 | 保留特性 | SQLite 时序 + 阈值告警(webhook) / 系统监控 / 加密 ImportExport / 自升级 + cfd 二进制 UI 升级 |
| D7 | token 落盘 | 明文 + 0600；**子进程注入走 `TUNNEL_TOKEN` env 不走 argv** |
| D8 | 命名 | 二进制 `cfdmgrd`；管理命令 `cfm`；Go 模块 `github.com/mia-clark/cloudflared-manager`；env 前缀 `CFDM_`；数据目录 `/var/lib/cfdmgrd`（Linux）/ `%ProgramData%\cfdmgrd`（Windows） |
| D9 | 配置文件格式 | YAML（双向编辑），导出/导入 JSON |
| D10 | 数据目录结构 | `{data_dir}/{profiles, logs, bin/cloudflared, series.db, meta.json}` |

---

## §1. 高层架构

### 1.1 进程拓扑

```
┌───────────────────────────────────────────────────────────────────────┐
│                       cfdmgrd（单 Go 守护进程）                          │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐   │
│  │ HTTP API (chi) + WebSocket /events + embed web/dist            │   │
│  │ Middleware: Bearer auth、CORS、recover、reqlog                  │   │
│  └─┬───────────────┬─────────────┬─────────────┬───────────────┬──┘   │
│    │               │             │             │               │      │
│  ┌─▼──────────┐ ┌──▼────────┐ ┌──▼──────────┐ ┌▼──────────┐ ┌─▼────┐ │
│  │ manager.   │ │ eventbus  │ │ metrics.    │ │ alerts.   │ │ cfd  │ │
│  │  Manager   │ │ (pub/sub) │ │  Sampler    │ │  Engine   │ │ bin. │ │
│  │ (实例 CRUD) │ │           │ │ (拉 /metrics)│ │  (rules)  │ │ Mgr  │ │
│  └─┬──────────┘ └─▲─────────┘ └─┬───────────┘ └─▲─────────┘ └──────┘ │
│    │              │             │               │                    │
│  ┌─▼──────────────┴────┐        │       ┌───────▼───────────────────┐│
│  │ process.Worker × N  │─事件───┘       │   SQLite (series + alerts)││
│  │ (每实例 1 个)         │                └───────────────────────────┘│
│  └─┬───────┬───────────┘                                              │
│    │       │ stderr/stdout pipe                                       │
│    │       ▼                                                          │
│    │   ┌─────────────────────┐                                        │
│    │   │ logtail.Process     │── WS /logs/tail                        │
│    │   │ Tailer (JSON+raw)   │── SQLite events 索引 + JSONL 滚动文件    │
│    │   └─────────────────────┘                                        │
└────┼─────────────────────────────────────────────────────────────────┘
     │  exec.Cmd: argv = ["tunnel", "run"], env = TUNNEL_TOKEN=...
     ▼
 ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
 │  cloudflared    │   │  cloudflared    │ … │  cloudflared    │
 │  (子进程)        │   │  (子进程)        │   │  (子进程)        │
 │  --metrics      │   │  --metrics      │   │  --metrics      │
 │  127.0.0.1:N    │   │  127.0.0.1:N+1  │   │  127.0.0.1:N+k  │
 └────────┬────────┘   └────────┬────────┘   └────────┬────────┘
          │  QUIC/HTTP2          │                    │
          ▼                      ▼                    ▼
              ┌─────────────────────────────────┐
              │  Cloudflare Zero Trust 边缘      │
              │  (ingress 与 public hostname     │
              │  在 CF dashboard 配置)            │
              └─────────────────────────────────┘
```

### 1.2 Go 模块布局

| 路径 | 角色 | 动作 |
|---|---|---|
| `cmd/cfdmgrd/main.go` | 入口：子命令 `serve` / `health` / `version` / `help` | 改造自 `cmd/frpsmgrd/main.go`；**删除 `frps-worker` 子命令** |
| `internal/api/` | HTTP + WS：chi 路由、handler、`openapi.yaml`、middleware | 框架 REUSE；handler 业务字段重写；新增 `binaries.go` / `token.go` |
| `internal/manager/` | 实例 CRUD、meta 索引、自启动、profiles 扫描 | 框架 REUSE；YAML 替 TOML；loopback 方法删除 |
| `internal/process/` | **新**：cloudflared 子进程管家（spawn / 信号 / 健康判定 / Wait） | 取代 `internal/manager/worker.go`，握手协议删除 |
| `internal/cfdbin/` | **新**：cloudflared 二进制多版本管理（下载、SHA256、镜像 fallback、active 切换） | 全新 |
| `internal/logtail/` | 子进程 stderr/stdout 日志环形缓冲 + WS 推送 + 结构化解析 | 新增 `ProcessTailer`；原 `Tailer` 保留供文件 tail 复用 |
| `internal/metrics/` | 定期拉 `/metrics`、Prometheus 文本解析、写 SQLite、告警评估 | 框架 REUSE；`InstanceSource.Loopback` → `MetricsAddr`；metric 字段表重写 |
| `internal/eventbus/` | 进程内 pub/sub + ring + filter + WS replay | 100% REUSE；事件类型清单更新 |
| `internal/sysinfo/` | 宿主资源 + 子进程 PID 资源 | 100% REUSE |
| `internal/selfupdate/` | 面板自升级（GitHub release + install.sh / install.ps1） | REUSE；repo 改名 + env 前缀改 |
| `internal/appcfg/` | 环境变量 → Config | env 前缀改 `CFDM_`；新增 `BinariesDir`、`DefaultBinaryVersion`、`DownloadMirrors`、`ExportPassphrase`、`GitHubToken` |
| `pkg/cfdconfig/` | **新**：`TunnelConfigV1` 数据模型 + YAML / JSON 编解码 + 字段校验 | 替代 `pkg/config/server.go` |
| `pkg/cfdflags/` | **新**：cloudflared CLI flag 元数据 + UI 表单 schema + flag↔env 映射 | 全新 |
| `pkg/cfdstate/` | `ConfigState` 枚举（Stopped/Starting/Started/Stopping） | 重命名自 `pkg/consts/state.go`；删除 `ProxyState` |
| `pkg/version/` | 编译期 ldflags 注入 + 运行时探测 cloudflared 版本 | REUSE；删除 `FRPVersion`；新增 `CloudflaredVersion(path)` |
| `pkg/util/` | 通用文件 / 字符串 / 杂项工具 | 100% REUSE，删除 `PruneByTag`（孤儿） |
| `web/src/` | React 单页（Antd 6 + Vite） | 框架 REUSE；页面整体重写（见 §11） |

### 1.3 删除清单

| 路径 | 原因 |
|---|---|
| `cmd/frpsmgrd/frps_worker.go` | cloudflared 是外部二进制，不需要 re-exec 自身做 worker |
| `pkg/config/server.go` 及 `testdata/` | ServerConfigV1 / TOML 双向，整体替换 |
| `pkg/consts/config.go` | frp 专有常量（Protocols/ProxyTypes/PluginTypes/AuthToken/STUN/Bandwidth） |
| `pkg/sec/passwd.go` | SHA1+Base64 弱哈希（仅服务 frps dashboard），cloudflared 无此概念 |
| `pkg/util/misc.go::PruneByTag` | 唯一调用者是 frp proxy filter，孤儿删除 |
| `internal/api/runtime.go` | frps mem/proxy/client 透传，cloudflared 无对外管理 API |
| `internal/manager/worker.go` | 整体搬到 `internal/process/`，删除握手协议与 loopback 端口分配 |
| `web/src/pages/ServerConfigGroups.tsx` | frps 配置 9 分组表单，业务全替换 |
| `web/src/pages/Runtime.tsx` | frps 客户端 / proxy 实时表 |
| `web/src/pages/TomlReference.tsx` + `tomlSnippets.ts` | TOML 参考，cloudflared 不用 TOML |
| `web/src/pages/serverConfigForm.ts` | frps 表单 schema |
| `web/src/api/types.ts` 中 frps 相关类型 | 类型整体重写 |
| `go.mod`：`fatedier/frp` 及其传递依赖（~25 个） | 见 §10.6 |

---

## §2. 数据模型与配置 schema

### 2.1 实例配置 `TunnelConfigV1`（Go struct）

> 位置：`pkg/cfdconfig/tunnel.go`
> YAML 字段命名风格：**camelCase**（与 cloudflared 上游 config.yml 风格一致）
> JSON tag 与 YAML tag 一致；token 字段在 `configs.Get` 的 envelope 中默认隐藏（见 §9）

```go
package cfdconfig

type TunnelConfigV1 struct {
    // —— 凭证 ——
    Token string `yaml:"token,omitempty" json:"token,omitempty"`
    // 高度敏感。GET /configs/{id} 默认不回显；GET /configs/{id}/token 才返回脱敏值；
    // GET /configs/{id}/raw 永远全文（API token 鉴权保护）

    // —— 边缘连接 ——
    Edge EdgeConfig `yaml:"edge,omitempty" json:"edge,omitempty"`

    // —— 可靠性 ——
    Reliability ReliabilityConfig `yaml:"reliability,omitempty" json:"reliability,omitempty"`

    // —— 日志 ——
    Logging LoggingConfig `yaml:"logging,omitempty" json:"logging,omitempty"`

    // —— 身份与标签 ——
    Identity IdentityConfig `yaml:"identity,omitempty" json:"identity,omitempty"`

    // —— 高级覆盖（逃生舱） ——
    // 自由 key=value 列表，启动子进程时合并进 env（cfdmgrd 强制注入的 env 优先级更高，不可覆盖）
    AdvancedEnvOverrides map[string]string `yaml:"advancedEnvOverrides,omitempty" json:"advancedEnvOverrides,omitempty"`

    // —— 运行时控制（不影响 cloudflared 进程行为，影响 cfdmgrd 自己） ——
    BinaryVersion string `yaml:"binaryVersion,omitempty" json:"binaryVersion,omitempty"`
    // 取值："" / "current" / 具体版本 tag（如 "2026.5.2"）；空 = 用全局默认
}

type EdgeConfig struct {
    Protocol         string `yaml:"protocol,omitempty" json:"protocol,omitempty"`         // auto | http2 | quic
    EdgeIPVersion    string `yaml:"edgeIpVersion,omitempty" json:"edgeIpVersion,omitempty"` // auto | 4 | 6
    EdgeBindAddress  string `yaml:"edgeBindAddress,omitempty" json:"edgeBindAddress,omitempty"`
    Region           string `yaml:"region,omitempty" json:"region,omitempty"`             // "" | us
    PostQuantum      bool   `yaml:"postQuantum,omitempty" json:"postQuantum,omitempty"`   // 仅 protocol=quic 时生效
}

type ReliabilityConfig struct {
    Retries     int    `yaml:"retries,omitempty" json:"retries,omitempty"`         // 默认 5
    GracePeriod string `yaml:"gracePeriod,omitempty" json:"gracePeriod,omitempty"` // 默认 30s，duration 字符串
}

type LoggingConfig struct {
    LogLevel          string `yaml:"logLevel,omitempty" json:"logLevel,omitempty"`                   // debug|info|warn|error|fatal
    TransportLogLevel string `yaml:"transportLogLevel,omitempty" json:"transportLogLevel,omitempty"` // 同上
    // —— 不暴露给用户编辑 ——
    // --logfile / --log-directory 由 cfdmgrd 强制接管（**不能让 cloudflared 写文件**，否则会取代 stderr，
    // 我们的日志管道就拿不到日志了 —— 这是一个真实的陷阱）
    // --output json 由 cfdmgrd 强制启用
}

type IdentityConfig struct {
    Label string            `yaml:"label,omitempty" json:"label,omitempty"`
    Tags  map[string]string `yaml:"tags,omitempty" json:"tags,omitempty"` // 注：cloudflared --tag 是重复 flag，落子进程时拼成 TUNNEL_TAG="k1=v1,k2=v2"
}
```

### 2.2 实例配置 YAML 样板

```yaml
# {data_dir}/profiles/<id>.yaml
token: eyJhIjoiMjk...   # 明文，文件 chmod 0600；GET /configs/{id} 不回显
binaryVersion: "current"

edge:
  protocol: auto         # auto | http2 | quic
  edgeIpVersion: "4"     # auto | 4 | 6
  region: ""             # "" | us
  postQuantum: false

reliability:
  retries: 5
  gracePeriod: 30s

logging:
  logLevel: info
  transportLogLevel: info

identity:
  label: home-nas        # 在 CF Zero Trust dashboard 上 connector 的展示名
  tags:
    env: prod
    site: shanghai

# 高级覆盖（仅在白名单 env 范围内允许）
advancedEnvOverrides:
  # 例：临时调试可加 TUNNEL_DNS_RESOLVER_ADDRS: 1.1.1.1,8.8.8.8
```

### 2.3 实例元数据 `MgrMeta`（与 frps-manager 现有保持 95% 兼容）

> 位置：`{data_dir}/meta.json`（顶层）+ `manager.MgrMeta`（每实例）

```go
type MgrMeta struct {
    Name          string `json:"name"`
    ManualStart   bool   `json:"manualStart"`
    BinaryVersion string `json:"binaryVersion,omitempty"` // 该实例锁定的 cloudflared 版本，空=用全局默认
}
```

`{data_dir}/meta.json` 顶层结构（沿用现有）：

```json
{
  "sort": ["instance-1", "instance-2"],
  "names": { "instance-1": "home-nas", "instance-2": "office-vpn" },
  "manual": { "instance-1": false, "instance-2": true },
  "binaryVersion": { "instance-2": "2025.10.0" },
  "log_view_since": { "instance-1": "2026-06-06T10:00:00Z" }
}
```

### 2.4 CLI flag ↔ env ↔ YAML 三向映射

> 位置：`pkg/cfdflags/mapping.go`
> 这个映射表是面板的"权威字段表"，前端表单 schema、后端启动 spawn、双向编辑都靠它

| YAML 路径 | UI 控件 | cloudflared CLI flag | env 名 | 默认值 | 注入方式 |
|---|---|---|---|---|---|
| `token` | password input | `--token` | `TUNNEL_TOKEN` | —— | **强制走 env** |
| `edge.protocol` | select | `--protocol` | `TUNNEL_TRANSPORT_PROTOCOL` | auto | env |
| `edge.edgeIpVersion` | select | `--edge-ip-version` | `TUNNEL_EDGE_IP_VERSION` | 4 | env |
| `edge.edgeBindAddress` | text（IP） | `--edge-bind-address` | `TUNNEL_EDGE_BIND_ADDRESS` | —— | env |
| `edge.region` | select | `--region` | `TUNNEL_REGION` | —— | env |
| `edge.postQuantum` | switch（联动 protocol=quic） | `--post-quantum` | `TUNNEL_POST_QUANTUM` | false | env |
| `reliability.retries` | number 1-20 | `--retries` | `TUNNEL_RETRIES` | 5 | env |
| `reliability.gracePeriod` | duration | `--grace-period` | `TUNNEL_GRACE_PERIOD` | 30s | env |
| `logging.logLevel` | select | `--loglevel` | `TUNNEL_LOGLEVEL` | info | env |
| `logging.transportLogLevel` | select（折叠） | `--transport-loglevel` | `TUNNEL_TRANSPORT_LOGLEVEL` | info | env |
| `identity.label` | text | `--label` | **无 env** | —— | **argv 例外**：`--label=<value>` 拼入 argv（label 非敏感） |
| `identity.tags` | chips 键值 | `--tag` | `TUNNEL_TAG` | —— | env，拼成 `k1=v1,k2=v2` |
| —（cfdmgrd 强制） | —— | `--no-autoupdate` | `NO_AUTOUPDATE` | true | **强制注入**：env + argv 双保险（避免与面板二进制管理冲突） |
| —（cfdmgrd 强制） | —— | `--metrics 127.0.0.1:<port>` | `TUNNEL_METRICS` | cfdmgrd 分配 | **强制注入**：从 20241-20999 池中按实例 id 分配 |
| —（cfdmgrd 强制） | —— | `--output json` | `TUNNEL_OUTPUT` | json | **强制注入**：日志结构化必需 |
| `advancedEnvOverrides` | 键值对编辑（折叠） | —— | 任意（白名单） | —— | env，受 `pkg/cfdflags.AllowedEnvWhitelist` 限制 |

### 2.5 黑名单 flag（绝不暴露）

下列 flag 在 cloudflared 源码中标记 `Hidden: true` 或语义对 token 模式无效；UI 即使在"高级覆盖"也禁止：

- `--config`、`--cacert`、`--origincert`、`--origin-cert`（local-managed 专用，token 模式不读）
- `--name`、`--id`、`--hostname`、`--url`、`--lb-pool`、`--api-url`、`--hello-world`（quick / named tunnel 用）
- `--proxy-*`（all）、`--http-host-header`、`--origin-server-name`、`--no-tls-verify`、`--no-chunked-encoding`、`--unix-socket`（origin 配置，CF 边缘下发）
- `--ha-connections`、`--max-edge-addr-retries`（Hidden，默认 4 / 8；改了会破坏 HA 拓扑）
- `--management-hostname`、`--edge`（Hidden，仅 Cloudflare 内部测试）
- `--rpc-timeout`、`--write-stream-timeout`、`--quic-*-flow-control-limit`、`--quic-disable-pmtu-discovery`（Hidden，QUIC 内部调参）
- `--is-autoupdated`、`--stdin-control`（Hidden，内部状态位）
- `--ssh-*`、`--bucket-name`、`--access-key-id`（SSH 日志上传）
- `--icmpv4-src`、`--icmpv6-src`（WARP routing 私网，独立特性）
- `--logfile`、`--log-directory`（与 cfdmgrd 日志管道冲突，绝对禁止）

### 2.6 字段校验规则

> 位置：`pkg/cfdflags/validate.go`，被 `internal/api/validate.go` 和 `pkg/cfdconfig.ParseTunnelYAML` 同时调用

- `token`：非空、长度 100-1500 字节、字符集 base64url（cloudflared token 是 base64 编码的 JSON）；解码后能拿到 `t`（tunnel ID UUID）字段视为有效
- `edge.protocol`：枚举 `auto|http2|quic`
- `edge.edgeIpVersion`：枚举 `auto|4|6`
- `edge.edgeBindAddress`：留空 OR 合法 IP；与 `edgeIpVersion` 联动校验（IPv4 地址但 `edgeIpVersion=6` → 报错）
- `edge.region`：枚举 `""|us`
- `edge.postQuantum`：bool；如 `true` 且 `edge.protocol != "quic"` → **强制报错**（cloudflared 启动会拒绝）
- `reliability.retries`：1-20
- `reliability.gracePeriod`：合法 duration（`1s` - `5m`）
- `logging.logLevel` / `transportLogLevel`：枚举 `debug|info|warn|error|fatal`
- `identity.label`：可选；如填写则字符集 `[a-zA-Z0-9_\-\. ]`、长度 1-64
- `identity.tags`：每对 `key` 字符集 `[a-zA-Z_][a-zA-Z0-9_]*`、长度 1-32；`value` 长度 0-128
- `advancedEnvOverrides`：每个 key 必须在 `pkg/cfdflags.AllowedEnvWhitelist`（即 §2.4 表中所有合法 env 名 + 一组 `TUNNEL_DNS_RESOLVER_ADDRS` 等放行项）；含 `TUNNEL_TOKEN` / `NO_AUTOUPDATE` / `TUNNEL_METRICS` / `TUNNEL_OUTPUT` 则拒绝（这些由 cfdmgrd 强制）

---

## §3. 进程模型与子进程管家

### 3.1 启动序列（伪代码）

> 位置：`internal/process/worker.go`

```go
// Spawn 拉起一个 cloudflared 子进程。返回 worker 句柄。
func Spawn(ctx context.Context, p SpawnParams) (*Worker, error) {
    // 1. 解析二进制路径（多版本管理）
    binPath := p.BinaryMgr.Resolve(p.BinaryVersion) // e.g. {data_dir}/bin/cloudflared/2026.5.2/cloudflared

    // 2. 分配 metrics 端口（按实例 id 在 20241-20999 哈希 + 探活）
    metricsPort := allocMetricsPort(p.InstanceID)
    metricsAddr := fmt.Sprintf("127.0.0.1:%d", metricsPort)

    // 3. 构造 argv —— 极简：tunnel + 强制 --no-autoupdate + 可选 --label + run
    //    顺序：tunnel 必须在 run 前；--no-autoupdate / --label 是 tunnel 子命令的 flag
    args := []string{"tunnel", "--no-autoupdate"}
    if p.Config.Identity.Label != "" {
        // label 是唯一没有对应 TUNNEL_* env 的 flag，必须走 argv（明文 label 非敏感）
        args = append(args, "--label", p.Config.Identity.Label)
    }
    args = append(args, "run")

    // 4. 构造 env —— 全部 TUNNEL_* + NO_AUTOUPDATE，token 绝不进 argv
    env := append(os.Environ(),
        "TUNNEL_TOKEN="              + p.Config.Token,
        "NO_AUTOUPDATE=true",
        "AUTOUPDATE_FREQ=87600h",                                   // 10 年，三保险
        "TUNNEL_METRICS="            + metricsAddr,
        "TUNNEL_OUTPUT=json",                                       // 强制 JSON stderr
        "TUNNEL_LOGLEVEL="           + valOr(p.Config.Logging.LogLevel, "info"),
        "TUNNEL_TRANSPORT_LOGLEVEL=" + valOr(p.Config.Logging.TransportLogLevel, "info"),
        "TUNNEL_TRANSPORT_PROTOCOL=" + valOr(p.Config.Edge.Protocol, "auto"),
        "TUNNEL_EDGE_IP_VERSION="    + valOr(p.Config.Edge.EdgeIPVersion, "4"),
        "TUNNEL_RETRIES="            + strconv.Itoa(valOrInt(p.Config.Reliability.Retries, 5)),
        "TUNNEL_GRACE_PERIOD="       + valOr(p.Config.Reliability.GracePeriod, "30s"),
    )
    if p.Config.Edge.Region != ""           { env = append(env, "TUNNEL_REGION="+p.Config.Edge.Region) }
    if p.Config.Edge.EdgeBindAddress != ""  { env = append(env, "TUNNEL_EDGE_BIND_ADDRESS="+p.Config.Edge.EdgeBindAddress) }
    if p.Config.Edge.PostQuantum            { env = append(env, "TUNNEL_POST_QUANTUM=true") }
    if len(p.Config.Identity.Tags) > 0      { env = append(env, "TUNNEL_TAG="+formatTags(p.Config.Identity.Tags)) }
    for k, v := range p.Config.AdvancedEnvOverrides {
        if !cfdflags.AllowEnvOverride(k) { return nil, fmt.Errorf("env %s not allowed", k) }
        env = append(env, k+"="+v)
    }

    cmd := exec.CommandContext(ctx, binPath, args...)
    cmd.Env = env
    cmd.SysProcAttr = platformProcAttr() // Linux/Darwin: Setpgid=true；Windows: CREATE_NEW_PROCESS_GROUP

    // 5. stdout + stderr 全管，喂给 ProcessTailer（日志解析 + WS + JSONL 滚动）
    stdoutPipe, _ := cmd.StdoutPipe()
    stderrPipe, _ := cmd.StderrPipe()

    if err := cmd.Start(); err != nil {
        return nil, fmt.Errorf("start cloudflared: %w", err)
    }

    w := &Worker{
        cmd:        cmd,
        instanceID: p.InstanceID,
        metricsAddr: metricsAddr,
        done:       make(chan struct{}),
    }
    // p.LogSink 实际是 ProcessTailer 工厂：For(instanceID) 返回该实例独占的 *ProcessTailer
    tailer := p.LogSink.For(p.InstanceID)
    tailer.Attach(stdoutPipe, stderrPipe)

    // 6. 唯一 cmd.Wait() 所有者：goroutine 等待退出 + close(done)
    go func() {
        _ = cmd.Wait()
        close(w.done)
        tailer.OnExit(w.cmd.ProcessState) // tailer 已绑定 instanceID，无需再传
    }()

    // 7. 等待健康判定（startupTimeout=30s），失败则 gracefulStop + 返回 err
    if err := waitHealthy(ctx, w, 30*time.Second); err != nil {
        _ = gracefulStop(w, 5*time.Second)
        return nil, err
    }
    return w, nil
}
```

### 3.2 健康判定（三层组合）

| 层 | 检查 | 含义 |
|---|---|---|
| (a) | `cmd.ProcessState == nil`（进程未退出） | 子进程还活 |
| (b) | `GET http://127.0.0.1:<metricsPort>/ready` 返回 200 | 至少 1 条边缘 HA 连接已建立 |
| (c) | JSON 中 `readyConnections >= 期望阈值` | HA 健康度 |

### 3.3 状态机

| 面板状态 | 判定 |
|---|---|
| `stopped` | 未启动 / 已主动停止 / exit code 0 或 SIGTERM 触发 |
| `starting` | spawn 后 0-30s 窗口，(b) 仍为 503 或不可达 |
| `started` | (a) 活 + (b) 200 + (c) `readyConnections >= 1` |
| `degraded` | (a) 活 + (b) 200 + (c) `readyConnections < 4` 持续 ≥ 30s |
| `unhealthy` | (a) 活 + (b) 持续 503 ≥ 30s（启动期）或 ≥ 15s（运行期）|
| `crashed` | (a) 已死，exit code 非 0 且非 SIGTERM/SIGKILL/SIGINT 触发 |

> 与现有 `pkg/consts/state.go` 的 `Stopped/Starting/Started/Stopping` 兼容：新增 `degraded` / `unhealthy` 用于子状态展示；底层 4 态机器不变（避免破坏 `internal/api/status.go` 与前端状态机）。

### 3.4 停止序列

> 位置：`internal/process/lifecycle.go`

```
1. send SIGTERM → 触发 cloudflared 优雅退出（grace 计时 30s 默认）
2. wait min(gracePeriod + 5s, hardTimeout=35s)
3. 若仍活 → send SIGTERM 再发一次（cloudflared 将第二次同信号视作 force shutdown）
4. wait 2s
5. 若仍活 → send SIGKILL（pgid 整组，确保 fork 出的辅助线程也清掉）
6. cmd.Wait() 回收（已在 step 6 启动期就接管）
```

**Windows 特殊处理**：Windows 不支持 POSIX 信号语义；`os.Process.Signal(os.Interrupt)` 只对同 console group 子进程有效。方案：
- 启动 cloudflared 时 `cmd.SysProcAttr.CreationFlags |= windows.CREATE_NEW_PROCESS_GROUP`
- 停止时调 `windows.GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid)` 传 Ctrl+Break
- 5s 超时后退化为 `cmd.Process.Kill()`（已通过 selfupdate 模块的现有 Windows 经验沉淀，复用其 helper）

### 3.5 重启策略（崩溃自愈）

- `manualStart=false` 的实例：crashed 状态 → 退避 5s 自动重启，连续 5 次失败后停在 `crashed`，触发告警
- `manualStart=true` 的实例：不自动重启，仅记录事件 + 推送告警

### 3.6 端口分配策略

- metrics 端口池：`20241-20999`（共 758 个，远超单机实例数实际上限）
- 分配算法：`(crc32(instanceID) % 758) + 20241` → 探活（`net.DialTimeout("tcp", addr, 100ms)`），冲突顺序往下找
- 持久化：分配结果存入 `meta.json::metricsPorts[instanceID]`，重启 cfdmgrd 时尽量沿用（避免前端 scrape URL 漂移）
- 端口检测失败：写日志 + WS 推送 `instance.error`，状态停在 `crashed`

### 3.7 事件输出

| 时机 | 事件类型 | payload |
|---|---|---|
| 状态变更 | `instance.state` | `{state, prev_state}` |
| 启动失败 / 健康失败 / 子进程异常 | `instance.error` | `{message}` |
| HA 连接数变化（每次 sampler 拉到新值 + 与上次比对有变） | `tunnel.conn_state` | `{tunnel_id, conn_index, region, state}` |

---

## §4. cloudflared 二进制管理

### 4.1 目录结构

```
{data_dir}/bin/cloudflared/
├── active.json                              # {"version": "2026.5.2"}（跨平台权威源）
├── current -> 2026.5.2/                     # 软链（Linux/Darwin only；Windows 缺）
├── 2026.5.2/
│   ├── cloudflared                          # 或 cloudflared.exe（Windows）
│   ├── meta.json                            # {version, sha256, source_url, mirror, downloaded_at, size, verified}
│   └── .verified                            # 空文件，存在表示已校验
├── 2026.4.1/
│   └── ...
└── 2025.10.0/
    └── ...
```

**权威源**：`active.json` 是**所有平台**的权威记录（跨平台一致）。`current` 软链在 Linux/Darwin 上**只是给用户在 shell 里手敲 `cfm` 命令时的便利访问入口**，不参与代码层路径解析；Windows 上不维护软链（需要管理员或开发者模式）。

**解析路径**：`internal/cfdbin.Resolve(version)`
- `version == "current"` 或 `""`：读 `active.json::version` → 拼 `{data_dir}/bin/cloudflared/<version>/cloudflared[.exe]`
- `version == "<tag>"`：直接拼 `{data_dir}/bin/cloudflared/<tag>/cloudflared[.exe]`
- 文件不存在 → 报错（不自动回退到 PATH，确保版本可控）

**写 active.json**：用临时文件 + `os.Rename` 原子替换，避免并发读到半写状态；Linux/Darwin 同时跑 `os.Symlink + os.Rename` 刷新 `current` 软链（失败仅记日志，不阻断 activate）。

### 4.2 首次启动捆绑

- cfdmgrd 二进制中通过 `//go:embed` **不内嵌** cloudflared（37-54 MB 会让二进制爆胖）
- 改方案：构建期把"推荐 cloudflared 版本"的下载 URL 与 SHA256 写入 `pkg/version`
- cfdmgrd 首次启动检测 `bin/cloudflared/` 为空 → 下载 + 校验 + 安装；下载失败 → 启动失败，提示用户手动放置

可选优化（Docker 镜像专用）：Dockerfile 在镜像构建期把推荐版 cloudflared 预下载到镜像层，避免容器首启等下载

### 4.3 GitHub Release 资产命名映射

> 位置：`internal/cfdbin/asset.go`

```go
func AssetName(version, goos, goarch string) string {
    switch goos {
    case "linux":
        switch goarch {
        case "amd64": return "cloudflared-linux-amd64"
        case "arm64": return "cloudflared-linux-arm64"
        case "arm":   return "cloudflared-linux-arm"      // ARMv6 软浮点
        case "armhf": return "cloudflared-linux-armhf"    // ARMv7 硬浮点（GOARCH 不直接产出，需 daemon 自检）
        case "386":   return "cloudflared-linux-386"
        }
    case "darwin":
        // Darwin 没有裸二进制，必须解包 .tgz
        return fmt.Sprintf("cloudflared-darwin-%s.tgz", goarch)
    case "windows":
        return fmt.Sprintf("cloudflared-windows-%s.exe", goarch) // 注意是 .exe 不是 .zip
    }
    return ""
}
```

**已知陷阱**（必须写进代码注释）：
1. RPM 用 `x86_64` / `aarch64`，但本项目走 GitHub 裸二进制不走 rpm，可忽略
2. ARM 32 位有两个 SKU（`arm` 软浮点 / `armhf` 硬浮点），GOARCH 不直接产出 `armhf`，要看 `/proc/cpuinfo` 的 `Features` 是否含 `vfpv3`
3. macOS pkg 文件名缺 `darwin` 段（`cloudflared-amd64.pkg`），不走该路径
4. FreeBSD 无官方 release，需用户自行 `go build` 后塞到 `bin/cloudflared/<version>/cloudflared`

### 4.4 SHA256 校验（必须做）

cloudflared 不上传独立 `SHA256SUMS` 文件，校验值只在 release notes body 的 markdown 里：

```markdown
### SHA256 Checksums:

cloudflared-linux-amd64: 5286698547f03df745adb2355f04c12dde52ef425491e81f433642d695521886
cloudflared-darwin-amd64.tgz: ...
```

流程：
1. `GET api.github.com/repos/cloudflare/cloudflared/releases/tags/<version>` → 拿 `body` 字段
2. 正则 `^([\w.\-]+):\s+([a-f0-9]{64})$` 多行匹配 → `{asset → sha256}`
3. 下载二进制到临时文件 → 计算 SHA-256 → 比对
4. 不匹配 → 删除 + 拒绝安装 + WS 推 `binary.upgrade` 失败事件 + 告警

### 4.5 镜像 fallback

env：`CFDM_DOWNLOAD_MIRRORS`（逗号分隔，默认值见下）

```
CFDM_DOWNLOAD_MIRRORS=https://gh-proxy.org/,https://gh-proxy.com/,https://v6.gh-proxy.org/,https://github.com/
```

策略：
- 优先级按列表顺序，每个镜像下载超时 30s
- 第一个镜像失败 → 自动切下一个（前端 WS 推送 `binary.upgrade::{stage:"mirror_switch", from, to}`）
- SHA256 不论镜像都必须匹配 GitHub API 返回的官方值（防镜像投毒）

### 4.6 平台特定后处理

| 平台 | 处理 |
|---|---|
| Linux | `chmod 0755`；目录 `0755`；meta.json `0644` |
| Darwin | 解包 `.tgz` → `xattr -dr com.apple.quarantine {path}/cloudflared`（无 quarantine 时静默成功） |
| Windows | 解除 MOTW：`Remove-Item -Path "$path:Zone.Identifier"`（容错失败）；ACL 继承默认 |

### 4.7 多版本切换与清理

| 操作 | API | 行为 |
|---|---|---|
| 列已装 | `GET /api/v1/binaries` | 读目录 + meta.json，返回 `[{version, sha256, downloaded_at, size, is_active, used_by_instances}]` |
| 列可下载 | `GET /api/v1/binaries/available` | 调 GitHub API（1h 缓存）；可选 `CFDM_GITHUB_TOKEN` 提升限流（未认证 60/h → 认证 5000/h） |
| 安装新版 | `POST /api/v1/binaries/install` body `{version}` | 异步任务，进度走 WS `binary.upgrade::{stage, percent, mirror}` |
| 设为默认 | `POST /api/v1/binaries/{version}/activate` | 原子写 `active.json`；Linux/Darwin 同时 `ln -sfn` |
| 删除 | `DELETE /api/v1/binaries/{version}` | 拒绝：被实例 pin 或是 active；否则递归删 |
| 自动清理 | env `CFDM_BINARIES_KEEP=3` | 保留 3 个最新（默认）；定时任务 |

### 4.8 升级时的进程协调

升级 cloudflared 二进制时**不影响**已运行实例：
- Linux/Darwin：旧实例持有的二进制是已被 exec 的句柄，删除目录 / 替换软链不影响其运行（Linux 的 unlink-while-running 语义）
- Windows：**文件被占用，不可替换**。策略：升级前提示用户"是否要重启使用 X 版本的所有实例？"；用户确认才进行替换；否则只下载新版本到 `2026.5.3/`，不动 `active.json`

实例真正切换版本的时机：
- 用户在实例详情页改 `binaryVersion` → 触发 reload（stop + start，新启动用新版）
- 用户在二进制管理页"将所有 pin 在 vX 的实例迁移到 vY" → 批量 reload

---

## §5. 指标采集与告警

### 5.1 端点选择

| 端点 | 用途 | 调用周期 |
|---|---|---|
| `GET /metrics` | Prometheus 文本，业务指标采集 | 默认 10s，可在 `[5s, 30s]` 调 |
| `GET /ready` | 健康探针（200 + readyConnections / 503） | 5s |
| `GET /healthcheck` | 进程存活探针（仅证明 HTTP 服务活；不做隧道判定） | 不用（已有 PID 监控） |
| `GET /debug/pprof/*` | 性能调试 | 不主动调，可在"诊断"页代理 |

### 5.2 必采指标（默认 12 项，避免 series 爆炸）

| # | 指标 | 处理 |
|---|---|---|
| 1 | `cloudflared_tunnel_ha_connections` | gauge 直接落 |
| 2 | `cloudflared_tunnel_total_requests` | counter，计算 rate(1s) 落"增量"列 |
| 3 | `cloudflared_tunnel_concurrent_requests_per_tunnel` | gauge（**实际是进程级单值**，UI tooltip 说明） |
| 4 | `cloudflared_tunnel_response_by_code{status_code=~"2..|4..|5.."}` | counter，按 2xx/4xx/5xx 三桶聚合，增量 |
| 5 | `cloudflared_tunnel_request_errors` | counter，增量 |
| 6 | `quic_client_smoothed_rtt{conn_index=0..3}` | gauge，4 条 conn |
| 7 | `quic_client_lost_packets{conn_index=0..3}` | counter，4 条聚合增量 |
| 8 | `cloudflared_proxy_connect_latency_{count,sum}` | histogram，只落 count/sum 算 avg |
| 9 | `go_goroutines` | gauge |
| 10 | `process_resident_memory_bytes` | gauge |
| 11 | `process_cpu_seconds_total` | counter 增量 |
| 12 | `build_info{version=...}` | label-only，缓存为实例的"实际运行 cloudflared 版本"（用于对账） |

诊断模式开关：`PUT /api/v1/configs/{id}/metrics-config body {fullMetrics: true}` → 解开剩余所有 cloudflared_* / quic_* / go_* 指标的采集

### 5.3 SQLite schema（复用现有 `internal/metrics/store.go`）

```sql
-- 复用现有 traffic 表，字段语义重定义
CREATE TABLE IF NOT EXISTS series (
    ts          INTEGER NOT NULL,            -- unix seconds
    instance_id TEXT NOT NULL,
    scope       TEXT NOT NULL,               -- 'tunnel' | 'edge_conn:0' | 'edge_conn:1' ...
    metric      TEXT NOT NULL,               -- 'ha_connections' | 'requests_2xx' | 'rtt' ...
    value       REAL NOT NULL,
    PRIMARY KEY (instance_id, scope, metric, ts)
);

CREATE INDEX IF NOT EXISTS idx_series_ts ON series(ts);
CREATE INDEX IF NOT EXISTS idx_series_instance ON series(instance_id, ts);

-- 告警相关沿用 store_alerts.go，无 schema 变化
```

保留策略：默认 30 天，env `CFDM_SERIES_RETENTION_DAYS` 配置；定时 vacuum。

### 5.4 告警规则模板（12 条默认）

> 位置：`pkg/cfdflags/alert_templates.go`；用户初次开实例时一键启用 / 可改阈值

| # | 名称 | 表达式 | 默认阈值 | for | 严重度 |
|---|---|---|---|---|---|
| 1 | HA 连接不足 | `ha_connections < 4` | < 4 | 2m | warning |
| 2 | HA 全部断开 | `ha_connections == 0` | == 0 | 30s | critical |
| 3 | /ready 探针失败 | （主动探测） | HTTP 非 200 ≥ 3 次 | — | critical |
| 4 | 重连风暴 | `rate(tunnel_register_success[5m]) > 6/min` | > 6/min | 5m | warning |
| 5 | 5xx 占比过高 | `sum(rate(resp_5xx[5m]))/sum(rate(resp_all[5m])) > 5%` | > 5% | 5m | warning（> 20% critical） |
| 6 | 请求错误激增 | `rate(request_errors[5m]) > 1/s` | > 1/s | 5m | warning |
| 7 | QUIC 高 RTT | `avg(smoothed_rtt) > 300ms` | > 300ms | 10m | warning |
| 8 | QUIC 丢包高 | `rate(lost_packets[5m]) > 5/s` | > 5/s | 5m | warning |
| 9 | UDP 丢报文 | `rate(udp_dropped_datagrams[5m]) > 1/s` | > 1/s | 5m | warning |
| 10 | 内存异常 | `resident_memory > 500MiB` | > 500 MiB | 15m | warning（> 1 GiB critical） |
| 11 | Goroutine 泄漏 | `go_goroutines > 5000` | > 5000 | 30m | warning |
| 12 | 进程重启 | `time() - process_start_time < 60s` | — | — | info |

webhook 推送：`POST <user-defined URL>`，body：

```json
{
  "rule_id": "ha_disconnected",
  "rule_name": "HA 全部断开",
  "instance_id": "home-nas",
  "instance_label": "Home NAS",
  "state": "firing",
  "value": 0,
  "threshold": 0,
  "metric": "ha_connections",
  "fired_at": "2026-06-06T10:00:00Z",
  "resolved_at": null,
  "severity": "critical"
}
```

### 5.5 调研中确认的字段陷阱（写进代码注释）

1. `/ready` 返回 JSON 字段是 **camelCase**（`readyConnections`、`connectorId`），不要按 snake_case 解析
2. `cloudflared_tunnel_concurrent_requests_per_tunnel` 命名带 `per_tunnel` 但实际是**进程级单值**（无 connection_id 标签）
3. `quic_client_receive_bytes`（**单数 receive**）—— 不是 `received_bytes`，曾因 issue #1098 缺失过，校对时注意
4. `cloudflared_tunnel_active_streams` / `timer_retries` / `tunnel_authenticate_success` / `requests_per_protocol` 在源码中**已被移除**，社区文档过时，不要采集这些 key
5. `cloudflared_tunnel_ha_connections` 显示 1 但实际 0 的 issue #1633 未修复 → **不能仅依赖此指标做硬告警**，必须配合 `/ready` 探针为权威源

---

## §6. 日志管道

### 6.1 子进程日志策略

**强制配置**（不暴露给用户）：
- `--output json`（通过 `TUNNEL_OUTPUT=json`）→ stderr 输出纯 JSON 行
- **不传** `--logfile` / `--log-directory`（**否则会取代 stderr，daemon 拿不到日志**）
- `--loglevel` / `--transport-loglevel` 由用户在 UI 调

### 6.2 ProcessTailer 接口

> 位置：`internal/logtail/process_tailer.go`（与现有 `Tailer` 并列；后者保留供 cfdmgrd 自身日志 tail）

```go
type ProcessTailer struct {
    instanceID string
    ring       *ring.Ring     // 容量 8000，并发安全
    diskWriter *lumberjack.Logger // {data_dir}/logs/<id>/cloudflared.jsonl，MaxSize=10MB MaxBackups=10 MaxAge=14d
    subs       []*subscriber
    seq        uint64
}

func NewProcess(instanceID string) *ProcessTailer
func (t *ProcessTailer) Attach(stdout, stderr io.Reader) // 启 2 个 goroutine，bufio.Scanner Buffer 1MB
func (t *ProcessTailer) Subscribe(filter Filter) (<-chan Entry, func()) // 第二返回值 = unsubscribe
func (t *ProcessTailer) Snapshot(filter Filter, limit int) []Entry
func (t *ProcessTailer) OnExit(state *os.ProcessState) // 注入一条 daemon 来源的"实例退出" Entry
func (t *ProcessTailer) Stop()

type Entry struct {
    Seq       uint64                 `json:"seq"`        // 单调递增，前端断线重连用
    Time      time.Time              `json:"time"`       // 优先取 JSON time，否则 time.Now()
    Level     string                 `json:"level"`      // info|warn|error|fatal|debug|unknown
    Message   string                 `json:"message"`    // JSON message；解析失败 = raw 整行
    Event     int                    `json:"event,omitempty"`
    ConnIndex *int                   `json:"conn_index,omitempty"`
    TunnelID  string                 `json:"tunnel_id,omitempty"`
    Raw       string                 `json:"raw"`        // 必填，前端"原文"按钮
    Fields    map[string]any         `json:"fields,omitempty"`
    Source    string                 `json:"source"`     // "stderr" | "stdout" | "daemon"
}

type Filter struct {
    MinLevel  string   // "debug"/"info"/"warn"/"error"；数值化后做 >= 比较
    Keyword   string   // 子串匹配 Message + Raw（**不正则**，避免 ReDoS）
    Events    []int
    ConnIndex *int
    Since     time.Time
}
```

### 6.3 解析降级（"JSON 优先 + raw 兜底"）

每一行：

1. `json.Unmarshal(line, &m)` 到 `map[string]any`
2. 成功 → 抽取 level / time / message / event / connIndex / tunnelID，剩余进 `Fields`
3. 失败（panic stack、go runtime 输出、非日志噪声、未来字段重命名）→ `Entry{Level: "unknown", Message: line, Raw: line, Fields: nil}`

**zerolog 重复 key 处理**：用 `json.Decoder` 而不是 `json.Unmarshal`，可以拿精确字节偏移；后者覆盖前者（与 cloudflared 自家 `consoleWriter` 一致）。

**等级映射兼容**：`"warn"` 与 `"warning"` 视为同档（早期版本用 `warning`）。

### 6.4 容量与限流

| 项 | 取值 |
|---|---|
| 内存环形 | 8000 行/实例，约 4-8 MB |
| 磁盘 JSONL | `MaxSize=10MB MaxBackups=10 MaxAge=14d`，单实例上限 ~110 MB |
| 订阅者 channel | 容量 4096，满则**丢最旧**（不能阻塞解析协程，否则反向阻塞 cloudflared stderr pipe） |
| WS 合并 | 20 ms 合并发送一次（多行一次 JSON 数组），降低前端重渲染压力 |
| 单订阅带宽 | 1 MB/s，超过则压缩为 `[skipped N lines]` 占位 |
| Scanner buffer | `bufio.Scanner.Buffer(64KB initial, 1MB max)`，否则 debug 模式 8-32KB 长行会触发 `ErrTooLong` |

`CFDM_LOG_RING_SIZE` 暴露环形大小调节（默认 8000；内存敏感场景可降到 1000）。

### 6.5 检索（HTTP + WS）

| API | 用途 |
|---|---|
| `GET /api/v1/configs/{id}/logs` | 历史检索；query: level/event/conn_index/q/since/until/limit(默认 500 max 5000)/cursor(seq) |
| `GET /api/v1/configs/{id}/logs/files` | 列磁盘 JSONL 滚动文件 |
| `DELETE /api/v1/configs/{id}/logs` | 清空（写 `meta.json::log_view_since` 水印；环形不真删，水印之前的视为不可见） |
| `GET /api/v1/configs/{id}/logs/tail` | WebSocket 实时尾随；同样支持 filter；服务端只推命中 filter 的 Entry |
| `GET /api/v1/configs/{id}/logs/download?format=jsonl|text&from=…&to=…` | 下载范围日志 |

---

## §7. HTTP API + WebSocket 事件

### 7.1 路由清单（基于现有 `internal/api/server.go`）

> 完整重表见 §10.3；下面只列**新增**与**显著改造**

**新增**：

| Method | Path | Handler | 说明 |
|---|---|---|---|
| GET | `/api/v1/binaries` | `bin.List` | 已装 cloudflared 版本 + 使用情况 |
| GET | `/api/v1/binaries/available` | `bin.Available` | 远端可下载版本（GitHub API，1h 缓存） |
| POST | `/api/v1/binaries/install` | `bin.Install` | 异步任务 ID 返回，进度走 WS |
| POST | `/api/v1/binaries/{version}/activate` | `bin.Activate` | 设默认 |
| DELETE | `/api/v1/binaries/{version}` | `bin.Delete` | 拒绝：被 pin 或是 active |
| GET | `/api/v1/configs/{id}/token` | `token.Get` | 脱敏（前 6 + 末 4，中间 ***） |
| PUT | `/api/v1/configs/{id}/token` | `token.Put` | 明文输入；不可走主 PUT /configs/{id} |

**改造**（语义或字段）：

| Method | Path | 改动 |
|---|---|---|
| GET | `/api/v1/configs/{id}` | envelope.config 类型 `*cfdconfig.TunnelConfigV1`；token 字段 `omitempty` 且默认隐藏（用 transient 字段） |
| GET | `/api/v1/configs/{id}/raw` | Content-Type `application/yaml`；token 字段全文（API token 鉴权保护） |
| PUT | `/api/v1/configs/{id}/raw` | 接收 YAML 字节 |
| POST | `/api/v1/configs/{id}/duplicate` | **强制清空 token**（防 token 复用导致两实例抢同一 connector） |
| POST | `/api/v1/validate` | 改为 TunnelConfigV1 校验（移除 frp ConfigValidator 依赖） |
| POST | `/api/v1/import/zip` | 接收加密 ZIP（AES-GCM）；form-data 含 `passphrase` |
| GET | `/api/v1/configs/{id}/export` | 加密（可选，看是否填 `passphrase`）；Content-Type `application/yaml` 或 `application/octet-stream` |
| GET | `/api/v1/export/all` | 加密 ZIP；文件名 `cloudflared-manager-export-<timestamp>.zip` |
| GET | `/api/v1/version` | 输出 `{daemon: vX, cloudflared: vY, build_date: ...}`；`frp` 字段删除 |
| GET | `/api/v1/metrics/{id}/traffic` | metric 取值集变化（见 §5.2） |

**删除**：

| Method | Path |
|---|---|
| GET | `/api/v1/runtime/{id}/overview` |
| GET | `/api/v1/runtime/{id}/proxies` |
| GET | `/api/v1/runtime/{id}/proxies/{name}` |
| GET | `/api/v1/runtime/{id}/clients` |

### 7.2 WebSocket 事件类型

| Type | Payload | 状态 |
|---|---|---|
| `instance.state` | `{state, prev_state}` | REUSE |
| `instance.error` | `{message}` | REUSE |
| `config.changed` | `nil` | REUSE |
| `config.deleted` | `nil` | REUSE |
| `log.line` | `Entry`（结构化） | REUSE，payload 升级为 §6.2 的 Entry |
| `alert` | `{rule_id, rule_name, instance_id, state, value, threshold, metric, fired_at, resolved_at, severity}` | REUSE |
| `tunnel.conn_state` | `{instance_id, conn_index, region, state: "up"|"down"}` | **NEW** |
| `binary.upgrade` | `{version, stage: "downloading"|"verifying"|"installing"|"done"|"failed", percent, message, mirror}` | **NEW** |
| `proxy.status` | — | **DELETED** |
| `proxy.connections` | — | **DELETED** |

### 7.3 OpenAPI / SDK 同步

`internal/api/openapi.yaml` 全文重写所有 schema；`web/src/api/schema.d.ts` 走 `npm run gen:api` 重生成。所有改动一并入 PR（前后端紧耦合，无版本垫片）。

---

## §8. 安全与凭证

### 8.1 token 处理

| 阶段 | 处理 |
|---|---|
| 接收（PUT /configs/{id}/token） | 明文 over HTTPS（生产）或 HTTP（dev）；Bearer 鉴权 |
| 落盘 | `{data_dir}/profiles/<id>.yaml` 中 `token: <plaintext>`；文件 `chmod 0600`；目录 `0700` |
| 进程注入 | **强制走 env `TUNNEL_TOKEN`，绝不进 argv**（避免 `ps auxe` 暴露） |
| API 回显 | `GET /configs/{id}` envelope 默认隐藏 token（用 `json:"-"` + 单独 token endpoint）；`GET /raw` 完整回显（已鉴权） |
| 日志 | logtail 解析时如发现疑似 token 模式的 base64（>= 100 字符）→ 脱敏（保前 6 末 4） |
| 复制实例 | `duplicate` 操作强制清空 token，要求用户重新填 |
| 导出 | 默认加密；未填 `passphrase` 时给前端强警告"你正在导出 N 个明文 token，确认？" |
| 备份 | 用户提供 passphrase 派生密钥（PBKDF2-HMAC-SHA256, 200000 iter）→ AES-GCM 加密整个 export bundle |

### 8.2 `--no-autoupdate` 强制

强制原因（必须写代码注释）：
- cloudflared 默认每 24h 自更新，下载新二进制 + spawn 新进程 + 优雅退出旧进程
- 这会让 cfdmgrd 失去对二进制路径和版本的所有权（PID 替换、`active.json` 失效）
- 在面板有"二进制 UI 升级 + 多版本并存"的前提下，两套升级机制必然打架

**三保险**：
1. argv 强制 `--no-autoupdate`
2. env 强制 `NO_AUTOUPDATE=true`
3. env 强制 `AUTOUPDATE_FREQ=87600h`（10 年）

### 8.3 API token（面板自身鉴权）

- 沿用 `CFDM_API_TOKEN` env，Bearer 鉴权（与现有逻辑一致）
- `/api/v1/health` 与 `/api/docs/*` 例外（无鉴权）
- 默认值：未设置时 cfdmgrd 拒绝启动；安装脚本会生成强随机 token 并写入 systemd env 文件
- "忘记 token" 救济：`fms info` → 读 `/etc/cfdmgrd/cfdmgrd.env`（需 root）

### 8.4 CORS

`CFDM_CORS_ORIGINS` 沿用现有逻辑（默认 `*`，生产应设具体域）。

### 8.5 `metrics` 端口安全

- 永远绑 `127.0.0.1:<port>`，不暴露到公网
- 不需要密码（cloudflared 自身不支持 metrics 端点鉴权）
- 容器化场景：daemon 与 cloudflared 在同 net namespace，loopback 互通；跨容器需走 unix socket（v1 不实现，记入未来选项）

### 8.6 弱哈希清理

删除 `pkg/sec/passwd.go`（SHA1+Base64，仅为 frps dashboard 兼容）；移除后静态扫描器不再报警。

---

## §9. 前端页面改造

### 9.1 页面清单

| 页面（现有） | 动作 | 改造后角色 |
|---|---|---|
| `Login.tsx` | REUSE | 输入 API token，不变 |
| `Dashboard.tsx` | REPLACE | 顶部概览：N 实例总数 / running / unhealthy / crashed；每实例卡片显示 label / state / readyConnections / 当前 cloudflared 版本 / 启动时长 |
| `Configs.tsx` | REPLACE | 实例列表 + 详情；详情含 §2.4 表单（5 分组）+ token 编辑 + YAML 双向编辑器（CodeMirror）+ 启停按钮 |
| `ServerConfigGroups.tsx` | **DELETE** | frps 强相关 |
| `Runtime.tsx` | **DELETE** | frps 客户端 / proxy 实时 |
| `Logs.tsx` | REUSE + 增强 | 多实例日志；按 level/event/connIndex/keyword 过滤；JSON Entry 字段树展开；导出 |
| `Traffic.tsx` | REPLACE | metrics 历史曲线：HA 连接数 / 请求 RPS（2xx/4xx/5xx 堆叠）/ RTT 多线 / 错误率 / 内存 |
| `Alerts.tsx` | REUSE + 模板化 | 12 条默认模板（§5.4）一键启用；自定义规则 CRUD |
| `System.tsx` | REUSE | 宿主系统监控 + 每实例 PID 资源 |
| `ImportExport.tsx` | REPLACE | YAML 导入 / 加密 ZIP 全量 |
| `Settings.tsx` | REUSE | API token / CORS / 日志级别 / 镜像源 |
| `About.tsx` | REUSE | 版本信息 / 链接 / 致谢 |
| `TomlReference.tsx` | **DELETE** | cfd 不用 TOML |
| `ToolsValidate.tsx` | REPLACE | 工具页：token 解析（不验证）、cloudflared --version 检查、二进制下载诊断、 连通性测试（GET /ready） |
| **NEW** `Binaries.tsx` | NEW | cloudflared 二进制管理：列已装版本 / 检查更新 / 下载 / 切换 / 删除 / 镜像源切换 |

### 9.2 表单组件

实例编辑表单严格按 §2.4 的 5 大分组：

```
[实例信息 / Label / Tags]   <- identity 折叠区
[token]                      <- 独立卡片，"显示/隐藏"开关
[边缘连接]                    <- protocol / edgeIpVersion / edgeBindAddress / region / postQuantum
[可靠性]                      <- retries / gracePeriod
[日志]                        <- logLevel / transportLogLevel
[运行时]                      <- binaryVersion 选择
[高级覆盖]                    <- 默认折叠，键值对编辑器；env 名实时校验
[YAML 源码]                   <- CodeMirror 双向编辑（与上面表单实时同步）
```

### 9.3 关键交互

- token 字段：默认 type=password，"显示"按钮 click hold 才明文
- protocol = http2 时 postQuantum 自动 disabled + 强制 false
- 实例卡片"启动"按钮：spawn → 30s 等待 → 成功显示 `started`，失败弹出最近 50 行 stderr
- "重载"语义：stop + start，UI 提示"约 30 秒"
- "复制"按钮：清空 token，复制其它字段；提示"必须填新 token"
- "下载日志"：选时间范围、JSONL or 纯文本，浏览器直接下载

---

## §10. 改造范围矩阵（开发清单）

### 10.1 模块矩阵（顶层）

| 路径 | 动作 | 关键改动要点 |
|---|---|---|
| `cmd/frpsmgrd/main.go` | **RENAME** → `cmd/cfdmgrd/main.go` | 删 `frps-worker` 子命令；env 全改名 |
| `cmd/frpsmgrd/frps_worker.go` | **DELETE** | cloudflared 外部二进制不 re-exec |
| `Makefile` | **REPLACE** | LDFLAGS 移除 FRPVersion；二进制名 `bin/cfdmgrd` |
| `go.mod` | **REPLACE** | 删 `fatedier/frp` + 25 间接依赖；加 `gopkg.in/yaml.v3` 与 `github.com/prometheus/common/expfmt` |
| `internal/manager/manager.go` | REUSE（少量 REPLACE） | profiles 扫 `*.yaml`；删 Loopback 方法；YAML 双向 |
| `internal/manager/instance.go` | REUSE | Snapshot 加 `BinaryVersion/TunnelIDMasked/PID/ConnectorID/EdgeConnections`；删 loopback() |
| `internal/manager/worker.go` | **DELETE**（搬到 internal/process） | 握手协议 + loopback 端口全删 |
| `internal/manager/worker_signal_*.go` | RENAME → `internal/process/` | 逻辑不变 |
| `internal/manager/meta.go` | REUSE | 0 修改 |
| `internal/process/` | **NEW** | spawn + 健康判定 + 状态机 + 信号 + Wait + 端口分配 |
| `internal/cfdbin/` | **NEW** | 二进制多版本管理（download/verify/activate/resolve） |
| `internal/api/server.go` | REUSE | 删 runtime 路由组；加 binaries + token 路由 |
| `internal/api/configs.go` | REPLACE | envelope.config 改类型；Frpsmgr → Cfdmgr；YAML/JSON 双轨 |
| `internal/api/runtime.go` | **DELETE** | — |
| `internal/api/lifecycle.go` | REUSE | reload 语义说明改"kill+respawn" |
| `internal/api/logs.go` | REUSE + 适配 | parseLogLineTimestamp 改 RFC3339；其余 (fsnotify/water_mark/ring) 不动 |
| `internal/api/metrics.go` | REUSE + REPLACE | metric 取值集替换；HTTP 路由不变 |
| `internal/api/events.go` | REUSE | 0 修改 |
| `internal/api/importexport.go` | REPLACE | YAML 解析；AES-GCM 加密；扩展名改 |
| `internal/api/system.go` | REUSE | /version 字段调整 |
| `internal/api/update.go` | REUSE + 新增 | 守护进程自升 100% 保留；新增 cloudflared 二进制升级 handler 至 `binaries.go` |
| `internal/api/validate.go` | REPLACE | 删 frp ConfigValidator；改为 TunnelConfigV1 字段校验 |
| `internal/api/helpers.go` | REUSE | 0 修改 |
| `internal/api/errors.go` | REUSE | 删 ProxyNotFound/Exists；加 BinaryNotFound/TunnelTokenInvalid |
| `internal/api/docs.go` | REUSE | 标题改 cfdmgrd |
| `internal/api/status.go` | REUSE | 0 修改 |
| `internal/api/openapi.yaml` | **REPLACE** | 全文重写 |
| `internal/api/apiresp/apiresp.go` | REUSE | 删 proxy ErrorCode |
| `internal/api/middleware/*` | REUSE | 0 修改 |
| `internal/api/binaries.go` | **NEW** | cloudflared 二进制管理 5 个 endpoint |
| `internal/api/token.go` | **NEW** | token Get/Put |
| `internal/appcfg/appcfg.go` | REPLACE | env 全改前缀 `CFDM_`；新增字段 |
| `internal/eventbus/bus.go` | REUSE | 0 修改 |
| `internal/eventbus/types.go` | REPLACE | 删 proxy 事件；加 tunnel.conn_state / binary.upgrade |
| `internal/logtail/tailer.go` | REUSE | 0 修改（继续供 cfdmgrd 自身文件 tail 用） |
| `internal/logtail/process_tailer.go` | **NEW** | §6.2 |
| `internal/sysinfo/*` | REUSE | 0 修改 |
| `internal/selfupdate/*` | REUSE | repo 常量改名；env 前缀改 |
| `internal/metrics/store.go` | REUSE | Scope 语义改 |
| `internal/metrics/store_alerts.go` | REUSE | Metric 取值集改 |
| `internal/metrics/sampler.go` | REPLACE | fetch 改 Prometheus 文本解析；InstanceSource 接口改 |
| `pkg/config/server.go` | **DELETE** | 整体替换 |
| `pkg/cfdconfig/` | **NEW** | TunnelConfigV1 + YAML 双向 + 校验 |
| `pkg/cfdflags/` | **NEW** | flag 元数据 + 映射 + 白名单 + 告警模板 |
| `pkg/cfdstate/` | RENAME（自 `pkg/consts/state.go`） | 删 ProxyState |
| `pkg/consts/config.go` | **DELETE** | frp 专属常量 |
| `pkg/sec/passwd.go` | **DELETE** | SHA1 弱哈希 |
| `pkg/util/file.go` | REUSE | 0 修改 |
| `pkg/util/misc.go::PruneByTag` | **DELETE** | 孤儿 |
| `pkg/util/strings.go` | REUSE | 0 修改 |
| `pkg/version/version.go` | REPLACE | 删 FRPVersion；新增 CloudflaredVersion(path) 函数 |

### 10.2 环境变量重命名

| 旧 | 新 | 默认 |
|---|---|---|
| `FRPSMGR_API_TOKEN` | `CFDM_API_TOKEN` | 必填 |
| `FRPSMGR_HTTP_ADDR` | `CFDM_HTTP_ADDR` | `:8080` |
| `FRPSMGR_DATA_DIR` | `CFDM_DATA_DIR` | Linux `/var/lib/cfdmgrd` / Windows `%ProgramData%\cfdmgrd` |
| `FRPSMGR_CORS_ORIGINS` | `CFDM_CORS_ORIGINS` | `*` |
| `FRPSMGR_LOG_LEVEL` | `CFDM_LOG_LEVEL` | `info` |
| `FRPSMGR_DOCS_ENABLED` | `CFDM_DOCS_ENABLED` | `true` |
| `FRPSMGR_SELF_UPDATE_ENABLED` | `CFDM_SELF_UPDATE_ENABLED` | `true` |
| `FRPSMGR_INSTALL_SH_URL` | `CFDM_INSTALL_SH_URL` | 官方 |
| `FRPSMGR_INSTALL_PS1_URL` | `CFDM_INSTALL_PS1_URL` | 官方 |
| —（新增） | `CFDM_CLOUDFLARED_DEFAULT_VERSION` | 编译期注入 |
| —（新增） | `CFDM_DOWNLOAD_MIRRORS` | `https://gh-proxy.org/,https://gh-proxy.com/,https://github.com/` |
| —（新增） | `CFDM_BINARIES_KEEP` | `3` |
| —（新增） | `CFDM_LOG_RING_SIZE` | `8000` |
| —（新增） | `CFDM_SERIES_RETENTION_DAYS` | `30` |
| —（新增） | `CFDM_GITHUB_TOKEN` | 空（提升检查更新限流） |
| —（新增） | `CFDM_METRICS_PORT_RANGE` | `20241-20999` |

### 10.3 完整 HTTP 路由清单

> 见调研主题 6 的 `existing_contracts` 章节（完整 70+ 行表），spec 不在此重复。落实到 `internal/api/openapi.yaml` 时按该表实施。

### 10.4 go.mod 瘦身

**保留直接依赖**：`github.com/coder/websocket`、`github.com/fsnotify/fsnotify`、`github.com/go-chi/chi/v5`、`github.com/shirou/gopsutil/v4`、`modernc.org/sqlite`

**新增**：`gopkg.in/yaml.v3`、`github.com/prometheus/common/expfmt`（解 Prometheus 文本格式）

**删除**（一次性）：
```
github.com/fatedier/frp
github.com/fatedier/golib
github.com/pelletier/go-toml/v2
github.com/Azure/go-ntlmssp
github.com/armon/go-socks5
github.com/coreos/go-oidc/v3
github.com/go-jose/go-jose/v4
github.com/golang/snappy
github.com/gorilla/mux
github.com/hashicorp/yamux
github.com/klauspost/reedsolomon
github.com/pion/dtls/v3
github.com/pion/logging
github.com/pion/stun/v3
github.com/pion/transport/v4
github.com/pires/go-proxyproto
github.com/quic-go/quic-go
github.com/samber/lo
github.com/songgao/water
github.com/spf13/cobra
github.com/spf13/pflag
github.com/templexxx/cpu
github.com/templexxx/xorsimd
github.com/tjfoc/gmsm
github.com/vishvananda/netlink
github.com/vishvananda/netns
github.com/wlynxg/anet
github.com/xtaci/kcp-go/v5
golang.zx2c4.com/wintun
golang.zx2c4.com/wireguard
gopkg.in/ini.v1
gopkg.in/yaml.v2          # 改用 v3
k8s.io/apimachinery
k8s.io/utils
sigs.k8s.io/json
sigs.k8s.io/yaml
```

跑 `go mod tidy` 时上面的 indirect 应被自动剔除。

---

## §11. 部署与安装

### 11.1 单二进制

- `make build-host` 产出 `bin/cfdmgrd`（约 25 MB，无 frp 依赖后比当前小很多）
- 首次启动检测 `bin/cloudflared/` 为空 → 自动下载推荐版本（写到 `{data_dir}/bin/cloudflared/<version>/`）
- 离线场景：用户手动放入二进制 + meta.json（提供工具页"导入本地二进制"）

### 11.2 Docker 镜像

`Dockerfile` 多阶段（沿用现有思路）：
1. node 阶段构建 web/dist
2. golang 阶段构建 cfdmgrd
3. **新增**：构建阶段下载推荐版 cloudflared（指定平台），SHA256 校验，置于镜像层 `/var/lib/cfdmgrd/bin/cloudflared/<version>/`
4. final 阶段：alpine + cfdmgrd + 预装 cloudflared
5. `ENTRYPOINT ["/usr/local/bin/cfdmgrd", "serve"]`
6. 默认 `EXPOSE 8080`、`VOLUME /var/lib/cfdmgrd`

### 11.3 安装脚本与 `cfm` 命令

| 文件 | 改造 |
|---|---|
| `scripts/install.sh` | 改名 / 仓库链接 / env 前缀 / 二进制名；保留 systemd/OpenRC/launchd 自适配 |
| `scripts/install.ps1` | 同上 + Windows 服务 |
| `scripts/install.sh` 生成的 `fms` | 改名 `cfm`；14 个子命令保持（`start/stop/restart/status/logs/enable/disable/info/config/version/install/update/uninstall/help`） |

### 11.4 systemd unit 模板

```ini
[Unit]
Description=cfdmgrd (cloudflared multi-instance manager)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/cfdmgrd/cfdmgrd.env
ExecStart=/usr/local/bin/cfdmgrd serve
Restart=on-failure
RestartSec=5s
User=cfdmgrd
Group=cfdmgrd
# 数据目录可写、二进制目录可写（升级用）
ReadWritePaths=/var/lib/cfdmgrd
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

### 11.5 国内镜像与加速

延续现有 `scripts/install.sh` 的镜像列表机制；改造时镜像路径目录改名（如 `gh-raw.966788.xyz/cloudflared-mgr/install.sh`）。

---

## §12. 测试策略

### 12.1 Go 单元测试

| 包 | 关键用例 |
|---|---|
| `pkg/cfdconfig` | YAML 双向往返；字段校验（含 postQuantum + http2 冲突）；token base64 解析 |
| `pkg/cfdflags` | flag → env 映射；env 白名单；告警模板加载 |
| `pkg/cfdstate` | 状态转换合法性 |
| `internal/process` | Spawn 失败路径（二进制不存在 / 端口冲突）；spawn 成功后 ctx 取消 → graceful stop；信号顺序（mock cmd） |
| `internal/cfdbin` | asset 命名映射（按 GOOS/GOARCH）；SHA256 解析 release body；镜像 fallback（mock HTTP） |
| `internal/logtail/process_tailer` | JSON 优先 / raw 兜底；ring 容量；订阅者满-丢-最旧 |
| `internal/metrics/sampler` | Prometheus 文本解析；rate 计算；告警 firing/resolved 状态机 |
| `internal/manager` | LoadAll 扫 *.yaml；duplicate 清 token；meta.json 字段兼容 |

### 12.2 集成测试

> 位置：`internal/integration_test/`（新增）

| 测试 | 验证 |
|---|---|
| 启停一个真实 cloudflared 实例（CI 提供 fake token，预期启动失败） | 状态机走到 `unhealthy`，错误事件推送 |
| `--metrics 127.0.0.1:0` + 自动发现端口（实际行为待 PoC 验证；fallback 用 cfdmgrd 预分配） | sampler 抓到 `cloudflared_*` 指标 |
| 加密 export → 解密 import 往返 | 字段完全一致 |
| 二进制下载（mock GitHub Release） | SHA256 验证通过 + active 切换 + 软链生效 |

### 12.3 前端测试

| 项 | 用 |
|---|---|
| 表单组件单测 | vitest + @testing-library/react；postQuantum 联动等关键交互 |
| YAML 双向 | CodeMirror 编辑器 onChange → 表单同步、反向同步 |
| WS 重连 | mock socket，断线 5s 后自动重连，seq 续传 |

### 12.4 验证矩阵（运行手测）

| 场景 | 验证手段 |
|---|---|
| token 不出现在 `ps auxe` | 启动实例后 `ps auxe \| grep cloudflared`，仅见 `tunnel run --no-autoupdate [--label ...]` |
| TUNNEL_TOKEN 在 `/proc/<pid>/environ` 不可被无关用户读 | Linux：环境变量按 procfs 权限（pid 所有者 0400） |
| `--no-autoupdate` 真的生效 | 启动 24h 不重启；日志含 `AutoUpdater is disabled` |
| metrics 端口可抓 | `curl http://127.0.0.1:<port>/metrics` 见 `cloudflared_tunnel_*` |
| `/ready` 正确返回 | 隧道全 up 时 200 + `readyConnections=4`；网络断时 503 + `readyConnections=0` |
| 协议切换生效 | `protocol=http2` 后日志含 "Connecting via HTTP/2" |
| label 在 CF dashboard 可见 | Zero Trust → Tunnels → connector 行 |
| 二进制升级不影响运行实例（Linux） | 切换 active version → 新启动用新版；旧实例仍跑旧版直到 reload |
| Windows 上 Ctrl+Break 优雅停止 | Windows 11 实测 |

---

## §13. 改造执行顺序（writing-plans 的依赖锁定）

> 一次性大 PR 不可接受；按以下顺序拆 8-10 个独立 PR

```
PR-01: 基础重命名（cmd/Makefile/go.mod 主体 + appcfg env 前缀 + selfupdate repo 名 + 删 frps-worker 子命令）
       → 此 PR 后项目仍能 build，但实例功能损坏（pkg/config 还没改）

PR-02: pkg/cfdstate 重命名 + pkg/consts/config.go 删除 + pkg/sec 删除 + pkg/util.PruneByTag 删除

PR-03: pkg/cfdconfig 新增（TunnelConfigV1 + YAML 双向）+ pkg/cfdflags 新增（flag 元数据 + 校验 + 告警模板）

PR-04: internal/process 新增（spawn + 健康判定 + 状态机 + 信号）+ internal/manager/worker.go 删除（搬迁）

PR-05: internal/cfdbin 新增（下载 + 校验 + 多版本 + 镜像 fallback）+ /api/v1/binaries 端点

PR-06: internal/logtail/process_tailer 新增（JSON 解析 + 双轨 + 容量限制）

PR-07: internal/metrics/sampler 重写（Prometheus 文本解析 + InstanceSource 接口改）+ 告警字段适配

PR-08: internal/api 业务改造（configs/validate/runtime-delete/importexport/token 新增 + envelope 改名 + openapi.yaml 全文重写）

PR-09: web/src 整体重写（页面、组件、API schema 生成）+ 删除 frps 强相关页

PR-10: scripts/install.{sh,ps1} 改名 + cfm 命令生成 + Dockerfile 多阶段含 cloudflared 预下载 + README 全文重写 + CHANGELOG

PR-11（可选）: 移除 fatedier/frp + 跑 go mod tidy + 删除全部 indirect 依赖（依赖前面 PR 已不再 import）
```

每个 PR 内部测试通过 + lint + go vet + tsc -b 全过，前后顺序锁定（PR-N 依赖 PR-N-1）。

---

## §14. 文档与 README

| 文档 | 动作 |
|---|---|
| `README.md` | 全文重写：介绍 cloudflared 多实例管理；快速安装；中国镜像；Docker；fms → cfm；FAQ |
| `CLAUDE.md` | 全文重写：项目级指令；移除 frp 字段绑定坑（不再适用）；保留 Windows shell 规范 |
| `docs/API.zh-CN.md` | 全文重写：权威字段表；按新 openapi.yaml 同步 |
| `docs/README-server.md` | **DELETE**（frps 强相关） |
| `docs/老系统win截图/` | **DELETE** |
| `CHANGELOG.md` | 增加大版本条目 `v2.0.0` 项目改名 + 业务替换；说明这是不兼容升级 |

---

## §15. 开放问题（spec 落地前需要再确认的点）

> 这些点不是阻塞设计，但建议在第一个 PoC PR（PR-01 或 PR-04）期间实测确认

1. **是否启用 `--metrics 127.0.0.1:0` 简化方案**：spec 主线是 **cfdmgrd 在 20241-20999 池里按 instanceID 预分配端口**（§3.6，可控、可对接外部 Prometheus）。可选优化：让 cloudflared 自己用 `:0` 让 OS 分配，daemon 解析启动 stderr `Starting metrics server on 127.0.0.1:NNNN/metrics` 那一行回报。后者代码更短但脆弱（解析依赖日志格式），且外部 scrape URL 在每次重启会漂移。**建议保留预分配方案**，PoC 期不切换。
2. **TUNNEL_OUTPUT env 是否真的生效**：cloudflared 的 env 映射有"约定"和"白名单"两套，`--output` 是否被 urfave/cli 默认 ENV 映射规则覆盖待实测；不行则显式 `--output json` 加 argv。
3. **`--label` 没有对应 env**：调研已确认，YAML 里有 label 时必须拼到 argv。是否给上游 cloudflared 提 PR 补 `TUNNEL_LABEL` env？短期接受 argv 明文（label 非敏感）。
4. **`/ready` JSON 字段命名稳定性**：调研显示 `readyConnections`、`connectorId` 是社区/Helm 常见用法，但官方文档无 schema 表。spec 内已要求"用 HTTP 状态码做决策，JSON 字段仅用于展示"，避免被字段重命名打脸。
5. **`cloudflared_tunnel_ha_connections` 在 issue #1633 显示不准**：spec 已约定"以 `/ready::readyConnections` 为权威，metric 仅做图表"。
6. **`management-diagnostics` 默认 true 安全审视**：cloudflared 2024.2.1 起默认开 `/debug/pprof` 等远程诊断路由（通过 management.argotunnel.com 鉴权）。是否需要 cfdmgrd 默认改成 false？倾向保留 true（CF 端有鉴权层），但 README 提示一句。
7. **Histogram series 数量爆炸**：cloudflared `connect_latency` 等 histogram 有 8 个 bucket，全采集会 ×8 series。spec 默认只采 `_count` 和 `_sum`，画 avg 不画 p95/p99；用户开"诊断模式"才采全 bucket。
8. **Windows 优雅停止**：必须用 `CREATE_NEW_PROCESS_GROUP` + `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT)`，否则只能 Kill；实施时仔细测试，可能需要 selfupdate 模块的 Windows helper 经验沉淀。
9. **token-file 是否未来切换**：cloudflared 2025.4+ 支持 `--token-file`，比 env 在容器中略安全（环境变量被 sidecar 读到的风险）；v1 用 env，v2 评估改 0600 文件 + `TUNNEL_TOKEN_FILE`。
10. **现有 SQLite 数据是否破坏性迁移**：现有 frps-manager 的 `series.db` 中字段（scope=server/proxy）与新方案不同；改造时直接 DROP TABLE 重建（项目改名等于全新部署），不做迁移。

---

## §16. 验收标准（done 的定义）

PR-10 合并后，下列每一条都满足：

- [ ] `bin/cfdmgrd serve` 在 Linux/Darwin/Windows 三平台启动 ≤ 3s
- [ ] 首次启动自动下载推荐版 cloudflared 并校验 SHA256 通过
- [ ] 浏览器打开 `http://localhost:8080/` 显示登录页；填 token 后进入 Dashboard
- [ ] 创建一个真实 tunnel token 的实例，点"启动" → 30s 内状态变 `started`，`readyConnections=4`
- [ ] `ps auxe | grep cloudflared` 看 argv 只含 `tunnel run --no-autoupdate`（可能含 `--label`），无 token
- [ ] `/proc/<pid>/environ` 不可被无关用户读
- [ ] 实例详情页 5 大分组表单可双向编辑；YAML 视图同步
- [ ] Logs 页能实时看到 JSON 解析的 Entry，按 level/event 过滤生效
- [ ] Traffic 页能看到 HA 连接数 / RPS / RTT 曲线
- [ ] Alerts 一键启用 12 条默认模板；触发 HA=0 → webhook 收到 POST
- [ ] System 页显示宿主资源 + 每个 cloudflared 子进程 PID 资源
- [ ] Binaries 页能列已装版本 / 检查新版 / 下载 / 切换 active / 删除
- [ ] ImportExport 加密往返：相同 passphrase 解出来字段一致
- [ ] `cfm info` 显示访问地址 + token
- [ ] `cfm logs -f` 跟随 cfdmgrd 自身日志
- [ ] Docker 镜像 < 100 MB，跑起来即时可用
- [ ] `go test ./...` 全绿；`go vet ./...` 0 警告；`golangci-lint run` 0 错误
- [ ] `npm run build` 前端构建通过；`tsc -b` 0 错误
- [ ] `go.mod` 中无 `fatedier/frp` 字样；`go mod tidy` 后 indirect 数量比当前少 ≥ 20

---

> _本 spec 为一次性 fork 改造的设计基线。后续 writing-plans 阶段会基于 §13 PR 拆分，给出每个 PR 的实现计划（含具体文件清单、测试用例、回滚策略）。_
