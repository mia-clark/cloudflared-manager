---
name: web-api-binding
description: Use this skill whenever you are about to write, modify, or debug ANY frontend code in web/src/ that calls the Go backend API (axios client, fetch, WebSocket). Triggers include adding a new page, wiring a form save handler, rendering a table from `/api/v1/...`, hooking up a WebSocket, or chasing a bug where "saving / loading / displaying doesn't work". This skill enforces reading the Go source of truth BEFORE writing or fixing the frontend binding, so you never guess at field names, casing, request shape, or response shape.
---

# Web ↔ Go API 对接强制对核流程

## 触发条件（命中任一即必须激活）

- 任意 `web/src/**` 下新增/修改一处对 `/api/v1/...` 的调用
- 任意 React 组件读取或渲染后端返回数据中的字段
- 任意 WebSocket 订阅（`/api/v1/events`、`/logs/tail`）
- 任意"保存失败 / 列表为空 / 编辑表单空白 / 字段对不上 / 400 / 409"类 Bug
- 调整 `web/src/api/schema.d.ts` 或 `web/src/api/types.ts`

> **本项目踩过的坑（不可忘）**：
> - 后端混用三种风格：**`ServerConfigV1` 子树 = camelCase**（沿用上游 frp `v1.ServerConfig` 规则）、**`Snapshot` / 系统监控 / WS 事件 = snake_case**、**`/runtime/{id}/*` 返回 frps 原生 = camelCase 透传**。混淆字段名会让保存/列表/编辑表单空白。
> - 上游 frp 保留**非常规** camelCase：`vhostHTTPPort`（不是 `vhostHttpPort`）、`tcpmuxHTTPConnectPort`（前缀 `tcpmux` 全小写）、`natholeAnalysisDataReserveHours`（前缀 `nathole` 全小写）、`autoGenPrivateKeyPath`（中间 `Gen`/`Key` 大写）、`tcpKeepalive`（末尾 `a` 小写）、`tokenEndpointURL`、`detailedErrorsToClient` — 写错 key 不会立刻报错，但下次回读时拿不到。
> - Go `encoding/json` 默认**大小写不敏感**匹配字段，所以写错也能写入成功，回读时却找不到 — 这种 Bug 隐蔽性极强。
> - `decodeJSON` 在 [internal/api/helpers.go](../../../internal/api/helpers.go) 使用 `DisallowUnknownFields()`，**前端多发一个 key 直接 400**（除非该类型有自定义 `UnmarshalJSON`）。
> - **运行时端点是透传 frps 原生 JSON**（非 Snapshot snake_case 风格），新手很容易以为也是 snake_case 然后拿不到字段。

---

## 强制步骤（不允许跳过）

### Step 1 — 定位后端 handler 与路由

在动手写前端代码前，**必须先**：

1. 打开 [internal/api/server.go](../../../internal/api/server.go) 找到目标路径对应的 handler 方法。
2. 打开该 handler 所在的 `internal/api/<name>.go`（如 `configs.go` / `runtime.go` / `metrics.go` / `logs.go` / `system.go`），完整读一遍：
   - 请求体结构体（如 `createReq`）— **入参契约**
   - `decodeJSON` 是否启用 — 若启用则 **多一个字段就 400**
   - 返回值（`WriteJSON(w, status, v)` 中的 `v`）— **出参契约**
   - 是否调 `writeRawJSON` 透传（用于 runtime 端点）— 字段来自 **frps 原生 API**，按 frp v0.69.1 源核对
3. 若返回的是 `manager.Snapshot` / `manager.MgrMeta` 等结构体，打开 [internal/manager/instance.go](../../../internal/manager/instance.go) 或 [internal/manager/manager.go](../../../internal/manager/manager.go) 看 JSON 标签，确认 camelCase 还是 snake_case。
4. 若入参/出参里出现 `ServerConfigV1`，必须翻到 [pkg/config/server.go](../../../pkg/config/server.go) 和上游 `$(go env GOMODCACHE)/github.com/fatedier/frp@v0.69.1/pkg/config/v1/server.go` + `common.go` 核对 JSON 标签。
5. 若是 runtime 透传端点，翻 frp v0.69.1 的 `server/api_handler.go` 看真实响应形状。

### Step 2 — 整理"入参 / 出参字段表"

在动手前，**用工具写下来**（哪怕只是 TodoWrite 一行也行）：

```
路径: POST /api/v1/configs
入参: {
  id: string,
  config: ServerConfigV1   (camelCase, 上游 v1.ServerConfig 所有字段),
  frpsmgr: { name, manualStart }
}
出参 201: ConfigEnvelope = Snapshot(snake_case) + { config, frpsmgr }
错误: 400 (id 非法/缺 id/未知字段), 409 (id 重复)
```

这一步可借助：
- [docs/API.zh-CN.md](../../../docs/API.zh-CN.md) 已整理的中文字段表
- [internal/api/openapi.yaml](../../../internal/api/openapi.yaml) 的路径定义
- [web/src/api/schema.d.ts](../../../web/src/api/schema.d.ts)（`npm run gen:api` 由 openapi 生成）
- 实地探测 `curl -H "Authorization: Bearer ..." http://localhost:8080/api/v1/...`

### Step 3 — 写前端代码

只有完成 Step 1/2 后才能动 `web/src/`。要求：

1. **字段名逐字 copy-paste 自 Go 源** — 不要靠记忆，不要由"驼峰直觉"猜测。
2. **大小写敏感** — `vhostHTTPPort` ≠ `vhostHttpPort` ≠ `vhostHTTPport`。
3. **入参用 TypeScript 类型** — 若 [web/src/api/types.ts](../../../web/src/api/types.ts) 没有定义，先补上，避免裸 `any`。
4. **响应字段的可选性** — 后端 `omitempty` 标签的字段在前端类型里必须标 optional (`?:`)，并在使用前 `??` 兜底。
5. **不要混 snake_case 与 camelCase**：
   - `ServerConfigV1` 子树（POST/PUT/PATCH /configs 的 `config` 字段、raw TOML、validate JSON）→ **camelCase**
   - `Snapshot` / `MgrMeta`（实例元信息，注意：`Snapshot` 是 snake_case 但 `MgrMeta` 是 camelCase！）/ 系统监控 → 主体 **snake_case**，`frpsmgr` 子对象 **camelCase**
   - WebSocket `Event` → **snake_case** (`config_id`/`ts`)，但 `data` 字段内部按事件类型有自己的风格
   - `/runtime/{id}/{overview,proxies,clients}` 响应 → **frps 原生 camelCase 透传**（不是项目风格）
   - 错误信封 → camelCase 内嵌（`error.code` / `error.message`）
6. **提交配置时剪空字段** — 后端 `DisallowUnknownFields` 严格，且 `transport`/`auth.oidc`/`sshTunnelGateway` 等空对象会让上游校验报错。建议用 helper（如 `web/src/pages/serverConfigForm.ts` 的 `pruneEmpty`）剪枝。
7. **三态布尔字段**（`detailedErrorsToClient` / `transport.tcpMux` 等 `*bool`） — antd Select 对 boolean value 不稳，用字符串 `''` / `'true'` / `'false'` 承载，提交前映射回 boolean/undefined。

### Step 4 — 验证

写完一处对接后，至少做以下**两项**：

1. **构建** `web/`（`npx tsc -b` + `npm run build`）看 TS 类型有没有报错。
2. **实跑** — 起 daemon（`./frpsmgrd serve` 或 `make run`），让前端真去打一次接口，在浏览器 Network 里确认：
   - 请求 payload 的 key 与后端结构体一致
   - 响应 body 的 key 与前端读取的 key 一致
   - 状态码符合预期（201/204/200/204/404/409/400 不能混）

> "类型检查通过" ≠ "对接正确"。Go 的大小写不敏感匹配会让错的 key 也成功写入但读不回来，**必须看一次真实请求-响应**。

---

## 反例（不要重蹈覆辙）

### ❌ 错误：以为 runtime 也是 snake_case

```tsx
// runtime/{id}/overview 是 frps 原生透传，camelCase
const resp = await client.get(`/api/v1/runtime/${id}/overview`);
console.log(resp.data.total_traffic_in);    // ❌ undefined (实际是 totalTrafficIn)
console.log(resp.data.client_counts);       // ❌ undefined (实际是 clientCounts)
console.log(resp.data.cur_conns);           // ❌ undefined (实际是 curConns)
```

### ✅ 正确：runtime 用 camelCase

```tsx
const resp = await client.get(`/api/v1/runtime/${id}/overview`);
const ov = resp.data as RuntimeOverview;
console.log(ov.totalTrafficIn, ov.clientCounts, ov.curConns);
```

### ❌ 错误：用列表 Snapshot 回填编辑表单

```tsx
// GET /configs 返回的 items 只是 Snapshot（无 config 字段）
const list = await client.get(`/api/v1/configs`);
openEditor(list.data.items[0]);
form.setFieldsValue({
  bindPort: list.data.items[0].bindPort,      // ❌ Snapshot 里没有 bindPort
  vhostHTTPPort: list.data.items[0].vhostHTTPPort,  // ❌ 同上
});
```

### ✅ 正确：编辑前抓完整 envelope

```tsx
const env = await client.get(`/api/v1/configs/${id}`);
form.setFieldsValue({
  bindPort: env.data.config.bindPort,
  vhostHTTPPort: env.data.config.vhostHTTPPort,
  name: env.data.frpsmgr.name,
  manualStart: env.data.frpsmgr.manualStart,
});
```

### ❌ 错误：提交空嵌套对象触发 400

```tsx
const payload = {
  id, frpsmgr: { name, manualStart },
  config: {
    bindPort,
    transport: {},          // ❌ 上游校验对空 transport 不友好
    auth: { oidc: {} },     // ❌ method=token 时不该带 oidc
    webServer: {},          // ❌ 本项目接管，不应发
  },
};
```

### ✅ 正确：用 pruneEmpty 剪枝 + 按需发送

```tsx
import { buildServerConfigPayload } from './serverConfigForm';

const config = buildServerConfigPayload(values);  // 内部已 pruneEmpty + 跳 webServer
const payload = { id, config, frpsmgr: { name, manualStart } };
```

---

## 已知契约速查（基于实地探测，不靠记忆）

| 接口 | 入参顶层 key | 出参顶层 key | 风格 |
|---|---|---|---|
| `GET /api/v1/configs` | — | `{ items: Snapshot[] }` | **snake_case**（id/name/path/state/last_error/started_at/stopped_at） |
| `POST /api/v1/configs` | `{id, config, frpsmgr}` | `ConfigEnvelope = Snapshot + {config, frpsmgr}` | 混：Snapshot snake，config camel，frpsmgr camel |
| `GET /api/v1/configs/{id}` | — | `ConfigEnvelope` | 同上 |
| `PUT /api/v1/configs/{id}` | `{config, frpsmgr}` | `ConfigEnvelope` | 同上 |
| `PATCH /api/v1/configs/{id}` | RFC 7396 merge patch on `ServerConfigV1` | `ConfigEnvelope` | camelCase merge |
| `GET/PUT /api/v1/configs/{id}/raw` | TOML 文本 | TOML 文本（camelCase 真整数） | frps 原生 TOML |
| `POST /api/v1/configs/{id}/{start,stop,reload}` | — | `Snapshot` | snake_case |
| `GET /api/v1/configs/{id}/status` | — | `Snapshot` | snake_case |
| `POST /api/v1/validate` | application/json: `ServerConfig` / 其它 CT: TOML | `{valid, errors?[], warnings?[]}` | — |
| `GET /api/v1/runtime/{id}/overview` | — | frps `/api/serverinfo` 透传 | **camelCase**（totalTrafficIn/curConns/clientCounts/proxyTypeCount/...） |
| `GET /api/v1/runtime/{id}/proxies` | — | `{ proxies: ProxyInfo[] }` | **camelCase**（name/type/status/curConns/todayTrafficIn/...） |
| `GET /api/v1/runtime/{id}/proxies/{name}` | — | 单 ProxyInfo（frps 404 → 本接口 404） | **camelCase** |
| `GET /api/v1/runtime/{id}/clients` | — | `ClientInfo[]` | **camelCase**（runID/addr/version/connectAt/...） |
| `GET /api/v1/metrics/{id}/traffic?scope=&key=&from=&to=&step=` | query string | `{ inst_id, scope, key, step, points: [{ts,in,out,conns}] }` | snake_case |
| `GET /api/v1/alerts` | — | `{ items: AlertRule[] }` | **snake_case**（id/name/enabled/inst_id/metric/op/threshold/for_seconds/target/webhook） |
| `POST /api/v1/alerts` | `AlertRule`（id 可省略自动生成） | `AlertRule` | snake_case |
| `GET/PUT/DELETE /api/v1/alerts/{id}` | — / `AlertRule` / — | `AlertRule` / 204 | snake_case |
| `GET /api/v1/alerts/events?state=&from=&to=` | — | `{ items: AlertEvent[] }` | snake_case（id/rule_id/inst_id/target/fired_at/resolved_at/value/state） |
| `GET /api/v1/configs/{id}/logs?lines=` | — | `{ lines: string[], next_offset: 0 }` | — |
| `GET /api/v1/configs/{id}/logs/files` | — | `{ items: [{path, rotated_at?}] }` | snake_case |
| `DELETE /api/v1/configs/{id}/logs` | — | 204（仅设清空水位，不删文件） | — |
| `WS /api/v1/configs/{id}/logs/tail` | — | per-frame `{line: string}` | — |
| `GET /api/v1/system/info` | — | snake_case 全套 | snake_case |
| `WS /api/v1/events` | `{action: 'filter'\|'unfilter', types?, config_ids?}` | `Event { seq, type, config_id, ts, data }` | snake_case 外层 + data 按 type 形状 |

完整字段表与样例：[docs/API.zh-CN.md](../../../docs/API.zh-CN.md)

---

## Self-Check（提交前问自己）

- [ ] 是否打开过对应的 Go handler 文件？
- [ ] 是否对照了 `Snapshot` / `MgrMeta` / `ServerConfigV1` / 上游 `v1.ServerConfig` 的 JSON 标签？
- [ ] runtime 端点是否按 **frps 原生 camelCase** 而非 Snapshot snake_case 处理？
- [ ] 前端使用的每一个字段，是否在 Go 源里都能搜到？
- [ ] 大小写是否逐字一致（特别是 `HTTP` / `URL` / `IP` / `tcpmux` / `nathole` 等不规则缩写）？
- [ ] 后端 `omitempty` 字段在前端是否标了 optional 并做了兜底？
- [ ] 配置提交是否走 `pruneEmpty` 剪枝避免空嵌套触发 400？
- [ ] 是否实跑了一次真实请求看 Network 面板？
- [ ] `docs/API.zh-CN.md` 是否需要同步更新？

只要有一项 NO，就停下，回到 Step 1。
