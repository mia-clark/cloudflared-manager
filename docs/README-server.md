# frps-manager — 部署与使用

`frpsmgrd` 是一个**无头 frps 服务端管理器**：在一台主机上同时托管 N 份 frps 配置，每份跑在独立 worker 子进程里（因 frp 的 `mem.StatsCollector` 是进程级全局单例，子进程是按实例隔离指标的唯一办法）。通过完整的 REST + WebSocket API 暴露管理面与可观测面：配置 CRUD、生命周期、可视化编辑（含 frps 全参数 9 分组表单）、运行时监控（客户端/隧道/总览）、历史流量曲线（SQLite 时序）、告警规则与事件。

> 内嵌 frp `v0.69.1`。单 Go 二进制（含前端 dist embed、纯 Go SQLite 驱动），无 cgo 依赖。

---

## 快速开始（docker compose）

```bash
cd deploy/
cp .env.example .env
# 至少改一下 FRPSMGR_API_TOKEN
openssl rand -hex 32  # 复制结果填进 .env

docker compose up -d --build
docker compose logs -f frpsmgrd
```

健康检查：

```bash
curl http://localhost:8080/api/v1/health
# {"status":"ok","uptime_s":3}
```

带 token 调用任意 API：

```bash
TOKEN=$(grep ^FRPSMGR_API_TOKEN= .env | cut -d= -f2)
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/v1/version
```

---

## 数据布局

容器卷挂在 `/data`，结构：

```
/data/
  ├── profiles/      # 每份 frps 配置一个 <id>.toml(纯 frp 原生格式, camelCase)
  ├── logs/          # 每实例独立 <id>.log(worker stdout/stderr 接管)
  ├── metrics.db     # SQLite 时序库(traffic_points/alert_rules/alert_events)
  └── meta.json      # 实例显示名、手动启动标记、列表排序、日志清空水位
```

> 升级、重装时保留 `/data`，配置就不会丢。

---

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `FRPSMGR_API_TOKEN` | ✓ | — | API 鉴权 Bearer Token |
| `FRPSMGR_HTTP_ADDR` |   | `:8080` | 监听地址 |
| `FRPSMGR_DATA_DIR`  |   | `/data` | 数据根目录 |
| `FRPSMGR_CORS_ORIGINS` |   | `*` | 逗号分隔的 CORS 白名单 |
| `FRPSMGR_LOG_LEVEL` |   | `info` | trace/debug/info/warn/error |
| `FRPSMGR_DOCS_ENABLED` |   | `true` | 是否暴露 `/api/docs` 浏览器 UI |

---

## 鉴权

- 所有 `/api/v1/*`（除 `/health`）要求 `Authorization: Bearer <token>`
- WebSocket 客户端如果无法设置 header，可用 query 参数：
  `ws://host:8080/api/v1/events?token=<token>`

---

## 核心端点（按职责分组）

完整 schema 见 [`internal/api/openapi.yaml`](../internal/api/openapi.yaml)（41 条路径）和 [`docs/API.zh-CN.md`](API.zh-CN.md)（中文详解）。

### 配置 CRUD

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET`    | `/api/v1/configs` | 列出所有 frps 实例（Snapshot，不含 config 体） |
| `POST`   | `/api/v1/configs` | 新建（JSON: `{id, config: ServerConfigV1, frpsmgr: MgrMeta}`） |
| `GET`    | `/api/v1/configs/{id}` | 详情（Snapshot + 完整 ServerConfigV1 + frpsmgr 元数据） |
| `PUT`    | `/api/v1/configs/{id}` | 全量替换 |
| `PATCH`  | `/api/v1/configs/{id}` | RFC 7396 合并补丁 |
| `DELETE` | `/api/v1/configs/{id}` | 删除（自动停止 + 删文件 + 清 meta） |
| `POST`   | `/api/v1/configs/reorder` | 持久化前端排序 |
| `POST`   | `/api/v1/configs/{id}/duplicate` | 按 `new_id` 复制 |
| `GET/PUT`| `/api/v1/configs/{id}/raw` | 直接读写 frps 原生 TOML（GET 输出 camelCase 真整数） |

### 生命周期

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST`   | `/api/v1/configs/{id}/start` | spawn worker 子进程（含 loopback 握手） |
| `POST`   | `/api/v1/configs/{id}/stop` | 优雅终止 worker（reap 单一所有者） |
| `POST`   | `/api/v1/configs/{id}/reload` | **= stop + start**（frps 服务端参数变更须重启） |
| `GET`    | `/api/v1/configs/{id}/status` | Snapshot |

### 配置校验（不落盘）

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST`   | `/api/v1/validate` | JSON 或 TOML body → `{valid, errors[], warnings[]}`（调上游 `ValidateServerConfig`） |

### 运行时监控（只读，经 worker loopback 代理 frps 原生 API）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET`    | `/api/v1/runtime/{id}/overview` | frps `/api/serverinfo`（总流量/连接/客户端数/各 proxy 类型计数） |
| `GET`    | `/api/v1/runtime/{id}/proxies` | 跨 8 类型聚合的活跃 proxy 列表 |
| `GET`    | `/api/v1/runtime/{id}/proxies/{name}` | 按名查单 proxy（frps 返 404 转译本接口 404） |
| `GET`    | `/api/v1/runtime/{id}/clients` | 活跃 frpc 客户端明细 |

> 透传 frps 原生 **camelCase** JSON（非 Snapshot snake_case 风格）；实例未运行返 409。

### 历史流量曲线

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET`    | `/api/v1/metrics/{id}/traffic?scope=&key=&from=&to=&step=` | SQLite 降采样查询（scope=server\|proxy，key=proxy 名，step 秒桶） |

### 告警

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET`    | `/api/v1/alerts` | 规则列表 |
| `POST`   | `/api/v1/alerts` | 新建规则（metric: conns/traffic_in_rate/traffic_out_rate；op: >/>=/</<=；for_seconds 去抖） |
| `GET/PUT/DELETE` | `/api/v1/alerts/{id}` | 单规则 CRUD |
| `GET`    | `/api/v1/alerts/events?state=&from=&to=` | 触发历史（state: firing\|resolved） |

### 日志

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET`    | `/api/v1/configs/{id}/logs?lines=200` | 按 LogViewSince 水位过滤后的最近 N 行 |
| `GET`    | `/api/v1/configs/{id}/logs/files` | 轮转副本列表 |
| `DELETE` | `/api/v1/configs/{id}/logs` | 设清空水位（不删物理文件） |
| `GET`    | `/api/v1/configs/{id}/logs/tail` | **WebSocket** 实时尾随 |

### 导入导出

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST`   | `/api/v1/import/{file,url,text,zip}` | 多种导入（payload 必须是 frps TOML） |
| `GET`    | `/api/v1/configs/{id}/export` | 单文件下载 |
| `GET`    | `/api/v1/export/all` | ZIP 备份（`frps-manager-export-<ts>.zip`） |

### 全局事件（WebSocket）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET`    | `/api/v1/events` | 全局事件流（见下节 schema） |

### 系统监控

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET`    | `/api/v1/system/info` | 聚合（host + cpu + memory + disk + network + connections + process） |
| `GET`    | `/api/v1/system/cpu?window=200ms` | 使用率 / 拓扑 / 每核 / load avg |
| `GET`    | `/api/v1/system/memory` | 虚存 + swap |
| `GET`    | `/api/v1/system/disk?paths=/foo,/bar` | 磁盘用量（默认 `/` + DATA_DIR） |
| `GET`    | `/api/v1/system/network` | 每网卡 cumulative bytes/packets |
| `GET`    | `/api/v1/system/connections` | TCP/UDP 总数 + 按状态分组 + daemon 自身持有的 |
| `GET`    | `/api/v1/system/process` | daemon 自身：RSS / 线程 / goroutine / open files |

---

## 浏览器版 API 文档

启动后访问 **<http://localhost:8080/api/docs/>** — 内置 [Scalar](https://github.com/scalar/scalar)（OpenAPI 3.1 原生支持），现代化 UI + "try it out" 调试。

- HTML 页：`GET /api/docs/`
- 原始 spec：`GET /api/docs/openapi.yaml`（也支持 `.json`）
- **默认免鉴权** — 与多数开源 daemon 惯例一致
- **关闭方式**：`FRPSMGR_DOCS_ENABLED=false`（三个 docs 路由返 404）

---

## WebSocket 事件 schema

WebSocket `/api/v1/events` 每个 frame 是一个 JSON Event：

```json
{
  "seq": 17,
  "type": "instance.state",
  "config_id": "main",
  "ts": "2026-06-05T07:30:00Z",
  "data": { "state": "started", "prev_state": "starting" }
}
```

事件类型：

| type | 触发 | data 形状 |
|---|---|---|
| `instance.state` | 启停/状态机变更 | `{state, prev_state}` |
| `instance.error` | 实例运行错误 | `{message}` |
| `config.changed` | 配置被新增/更新 | `null` |
| `config.deleted` | 配置被删除 | `null` |
| `alert` | 告警 firing/resolved | `{rule_id, rule_name, target, state, value, threshold, metric, fired_at, resolved_at}` |
| `log.line` | 日志行（仅 `/logs/tail`） | `{line}` |

订阅端可在连接后发送二次过滤：

```json
{"action":"filter","types":["instance.state","alert"],"config_ids":["main"]}
```

或 `{"action":"unfilter"}` 取消。

---

## 创建 frps 实例完整示例

```bash
TOKEN=$(grep ^FRPSMGR_API_TOKEN= .env | cut -d= -f2)
BASE=http://localhost:8080

# 1. 创建配置（frps 服务端参数走 ServerConfigV1，全 camelCase）
curl -X POST $BASE/api/v1/configs \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "id": "main",
    "config": {
      "bindPort": 7000,
      "vhostHTTPPort": 8080,
      "vhostHTTPSPort": 8443,
      "subDomainHost": "frp.example.com",
      "auth": { "method": "token", "token": "强随机字符串" },
      "transport": { "tcpMux": true, "heartbeatTimeout": 90 },
      "log": { "to": "console", "level": "info", "maxDays": 7 }
    },
    "frpsmgr": { "name": "主服务端", "manualStart": false }
  }'

# 2. 启动
curl -X POST $BASE/api/v1/configs/main/start \
  -H "Authorization: Bearer $TOKEN"

# 3. 看总览
curl -H "Authorization: Bearer $TOKEN" $BASE/api/v1/runtime/main/overview
# {"version":"0.69.1","bindPort":7000,...,"totalTrafficIn":0,"clientCounts":0,...}

# 4. 客户端连上来后看明细
curl -H "Authorization: Bearer $TOKEN" $BASE/api/v1/runtime/main/clients
curl -H "Authorization: Bearer $TOKEN" $BASE/api/v1/runtime/main/proxies

# 5. 历史流量（最近 1 小时，60s 桶）
NOW=$(date +%s)
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/v1/metrics/main/traffic?scope=server&from=$((NOW-3600))&to=$NOW&step=60"
```

### 请求体顶层结构

```jsonc
{
  "id": "main",                 // 仅 a-zA-Z0-9 _ -，最长 64
  "config": { /* ServerConfigV1，即 frp v1.ServerConfig camelCase */ },
  "frpsmgr": {
    "name": "显示名",           // 列表/卡片显示用，空则回落到 id
    "manualStart": false        // true = 仅手动启动；false / 缺省 = daemon 启动时自动 Start
  }
}
```

> daemon 重启行为：所有 `frpsmgr.manualStart != true` 的实例都会在 `frpsmgrd serve` 启动时自动拉起。启动顺序遵循 `meta.json` 的 `sort` 列表。

### 关键字段速查（来自上游 v0.69.1）

```jsonc
{
  "bindPort": 7000,                  // frpc 主连接端口
  "kcpBindPort": 7000,               // KCP（与 bindPort 端口共享或独立）
  "quicBindPort": 7000,              // QUIC
  "vhostHTTPPort": 8080,             // HTTP vhost（注意不规则: HTTPP 不是 HttpP）
  "vhostHTTPSPort": 8443,            // HTTPS vhost
  "subDomainHost": "frp.example.com",
  "auth": {
    "method": "token",               // 或 "oidc"
    "token": "...",
    "oidc": { "issuer": "...", "audience": "..." }
  },
  "transport": {
    "tcpMux": true,                  // 三态 *bool: 未设/true/false
    "heartbeatTimeout": 90,
    "maxPoolCount": 5,
    "quic": { "keepalivePeriod": 10, "maxIdleTimeout": 30 },
    "tls": { "certFile": "...", "keyFile": "..." }
  },
  "allowPorts": [ {"start": 6000, "end": 7000}, {"single": 8000} ],
  "maxPortsPerClient": 50,
  "sshTunnelGateway": {
    "bindPort": 2222,
    "autoGenPrivateKeyPath": "./.autogen_ssh_key"   // 注意：autoGen 不是 AutoGEN
  },
  "log": { "to": "console", "level": "info", "maxDays": 7 }
}
```

> **重要**：`webServer` 字段会被本管理器 worker 启动时**强制覆盖为 loopback + 随机账密**（用于父进程经 loopback 读 frps mem 指标）。在表单/TOML 里写的 webServer 值**不会对外生效**，仅作记录。详见 [`docs/superpowers/specs/2026-06-04-frps-manager-transformation-design.md`](superpowers/specs/2026-06-04-frps-manager-transformation-design.md) §3。

---

## 网络模式

- **推荐 `network_mode: host`** — 所有 frps worker 子进程监听的端口（bindPort/vhost*/kcp/quic/SSH 网关）直接对外可达。
- 桥接模式可用但**必须显式 expose 所有 frps 用到的端口**（每个实例都不同），管理麻烦。

---

## 升级

1. `docker compose pull` 或 `git pull && docker compose build`
2. `docker compose up -d`（`restart: unless-stopped` 会自动重新拉起）
3. 升级期间 `/data` 持久化，配置和指标数据不丢

> 已运行的 frps 子进程会被 worker shutdown 信号回收；新版父进程会按 meta.json 顺序重新自启所有非 manualStart 的实例。

---

## 本地开发

```bash
# 直接跑（含 dev token）
make run

# 单测
make test

# 交叉编译 Linux 二进制
make build

# API 烟测（71 用例，需要 daemon 在 :8088 上跑）
BASE=http://localhost:8088 TOKEN=dev bash scripts/api-smoke.sh

# 前端端到端
cd web && npx playwright test
```

---

## 故障排查

| 症状 | 排查 |
|---|---|
| **401 unauthorized** | `FRPSMGR_API_TOKEN` 不对齐；WS 用 `?token=` |
| **404 在 WS 时** | 路径必须是 `/api/v1/events`（含 `/api/v1` 前缀） |
| **`/runtime/{id}/*` 返回 409 invalid_state** | 实例未运行，先 `POST /start` |
| **start 后立即 stopped** | 子进程握手失败（端口被占？看实例日志 `<id>.log` 头几行） |
| **`PUT /raw` 返 400 parse 错误** | TOML 语法错；frps 顶部需 `version = "1"`（无此行也能解析，但显式更稳） |
| **创建配置返 400 unknown field** | 用了 frps v1 不认的字段（`DisallowUnknownFields` 严格模式） |
| **重启 daemon 后实例没自启** | 检查 `meta.json.manual[id]` 是否被设为 true，或 `manualStart` 字段 |
| **容器健康检查失败** | `docker compose exec frpsmgrd frpsmgrd health` |
| **流量曲线一直是 0** | 客户端没连，或采样器还没跑（默认 10s 间隔）；db 文件查：`sqlite3 /data/metrics.db "SELECT * FROM traffic_points LIMIT 5"` |
