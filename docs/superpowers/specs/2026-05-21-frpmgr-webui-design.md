# frpmgr WebUI 设计 spec

**日期**：2026-05-21
**目标**：为 `frp-manager-server` 后端构建一套现代化、可嵌入 Go 二进制的浏览器 UI，完整覆盖老 Windows GUI（frpmgr 1.26.1）的所有功能，并加入后端独有的系统监控、实时事件流、跨实例运维能力。

---

## 1. 技术栈

| 层 | 选择 | 说明 |
|---|---|---|
| 构建 | Vite 7 + TypeScript 5 | 极速 HMR、原生 ESM 产物 |
| UI 框架 | React 19 | 配合 antd v5 + Refine |
| 组件库 | Ant Design v5 | Pro 后台风，原生支持亮暗双主题 token |
| 路由 + CRUD | Refine v4 + `@refinedev/antd` | 列表/编辑/分页/筛选自动化 |
| 远程状态 | TanStack Query v5（Refine 内置） | 缓存、自动重试、WebSocket 失效 |
| HTTP | openapi-fetch（基于 OpenAPI 生成） | 类型安全 |
| 类型生成 | openapi-typescript | 从 internal/api/openapi.yaml 生成 schema |
| WebSocket | 原生 WebSocket + 自定义 hook | 事件流 / 日志 tail |
| 图表 | @ant-design/charts (G2) | Dashboard / System 页面 |
| 包管理 | pnpm | 节省磁盘 + 严格依赖树 |
| 部署 | go:embed | 单二进制发布 |

## 2. 部署架构

```
frpmgrd 二进制
├── HTTP API   /api/v1/*       现有
├── WebSocket  /api/v1/events  现有
├── OpenAPI    /api/docs/*     现有
└── WebUI      /*              新增：go:embed webui/dist/
    ├── /                      SPA 入口
    ├── /assets/*              静态资源
    └── /index.html            fallback (SPA history mode)
```

Vite 构建产物 `webui/dist/` 在 Go 端通过 `//go:embed all:webui/dist` 嵌入。Go `internal/api/webui.go` 提供：
- 优先匹配静态资源（带正确 MIME + 长缓存头）
- 未匹配的 GET 请求 fallback 到 `index.html`（SPA 路由）
- `/api/*` 不被劫持（路由优先级高于 fallback）

开发态：Vite dev server (port 5173) 代理 `/api/*` 到 `http://localhost:8080`。

## 3. 路由设计

```
/login                            登录页
/                                 重定向 → /dashboard
/dashboard                        仪表盘
/configs                          配置列表
/configs/new                      新建配置
/configs/:id                      配置概览（重定向 → proxies）
/configs/:id/edit                 编辑配置（7 tab）
/configs/:id/proxies              代理列表
/configs/:id/proxies/new          新建代理
/configs/:id/proxies/:name/edit   编辑代理（6 tab + 类型联动）
/configs/:id/logs                 日志 tail + 历史文件
/configs/:id/raw                  原始 TOML 查看 / 编辑
/events                           全局事件中心
/system                           系统监控
/tools/import                     导入 (file/url/text/zip)
/tools/validate                   校验
/tools/nathole                    NAT 探测
/settings                         设置（个人 / 应用 / 关于）
```

侧栏分组：仪表盘 · 配置 · 全局事件 · 系统监控 · 工具 · 设置。

## 4. 数据层

**dataProvider**：自定义实现 Refine 数据提供方接口，底层调 openapi-fetch 生成的客户端。所有 CRUD 自动类型推导。

**资源映射**：

| Refine resource | API endpoint |
|---|---|
| `configs` | `/api/v1/configs` |
| `configs/:id/proxies` | `/api/v1/configs/{id}/proxies` |
| `configs/:id/logs` | `/api/v1/configs/{id}/logs` (tail via WS) |
| `system` | `/api/v1/system/info`（聚合） |
| `events` | `/api/v1/events`（WebSocket only） |

**WebSocket 客户端**：
- `useEventStream()` hook：连接 `/api/v1/events?token=...`，自动重连（指数退避），事件按 type 分发。
- 收到 `config.status`、`proxy.status`、`proxy.connections` 等事件时，调用 `queryClient.invalidateQueries(['configs', id])` 让相关查询自动刷新。
- 收到 `system.alert` 类事件时，触发 `<EventToast>`。

**轮询策略**：
- 系统指标（CPU/内存）默认 5s 轮询，可在设置里调（1s/5s/10s/30s）。
- WebSocket 断开时自动切换到 5s 轮询作为降级。

## 5. 状态管理

无 Redux/Zustand 这类全局 store。以 TanStack Query 管远程态、React Context 管极少量全局态：

- `AuthContext`：token、登录状态、登出方法。token 持久化到 localStorage（"记住登录"）或 sessionStorage（不记住）。
- `ThemeContext`：theme = `light` | `dark` | `system`，持久化到 localStorage，监听系统 `prefers-color-scheme`。
- `PreferencesContext`：默认首屏、轮询间隔、通知开关，持久化到 localStorage。

## 6. 认证

- 登录页输入 token，调 `GET /api/v1/health` 带 `Authorization: Bearer <token>` 校验。
- 200 → 写 localStorage/sessionStorage，跳 `/dashboard`。
- 任意请求 401 → 清 token，跳 `/login` 并 toast "登录已过期"。
- 401 拦截在 openapi-fetch middleware 实现。

## 7. 视觉规范

**主题 token**（基于 antd v5 ConfigProvider）：

| Token | Light | Dark |
|---|---|---|
| colorPrimary | `#1677ff` | `#1668dc` |
| colorBgLayout | `#f5f5f5` | `#0a0a0a` |
| colorBgContainer | `#ffffff` | `#141414` |
| borderRadius | `6` | `6` |
| fontFamily | -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei" | 同 |

**布局**：
- 侧栏宽度 240px（展开）/ 64px（折叠），可拖拽边缘调整。
- 顶栏高度 56px，sticky。
- 内容区 padding 24px，最大宽度 1600px（>1600 居中）。
- 卡片间距 16px。

**反馈一致性**：
- 所有写操作（启动/停止/删除/保存）必有 antd `message` 或 `notification` 反馈。
- 危险操作（删除配置、强制停止）必经 `Modal.confirm` 二次确认，删除配置要求输入实例名匹配。
- 长时操作（导入大 zip、NAT 探测）显示进度条或 `Spin tip="..."`。
- 行内编辑（如 inplace 重命名）回车确认 + Esc 取消。

## 8. 页面规范

### 8.1 登录页 `/login`
- 居中卡片（width 400px），上 Logo，下 Token 输入（password 输入，可切显），「记住登录」勾选。
- 显示后端版本号（来自 `/api/v1/version`，无需鉴权调用）。
- 错误态：token 错误 toast "认证失败，请检查 Token"。
- 主题切换器在右上角浮动。

### 8.2 仪表盘 `/dashboard`
顶部 4 张 `MetricCard`：
- 配置总数（运行中 / 总数，绿色脉冲点）
- 代理总数（启用 / 总数）
- 实时连接数（聚合所有代理）
- 今日流量（上行 + 下行，单位自适应 KB/MB/GB）

中间 2 列：
- 左：CPU 实时折线（最近 5 分钟，平滑曲线 + 当前值大字）
- 右：内存实时折线（同上）

下部：
- 配置概览表格（精简版，名称/状态/服务器/代理数/操作）
- 最近事件（最近 10 条，"查看全部" 跳 `/events`）

### 8.3 配置列表 `/configs`
- Refine `<List>` + antd `<Table>`，列：状态点 / 名称 / 服务器地址 / 协议 / 代理数 / 自动启动 / 更新时间 / 操作
- 工具栏：搜索框、刷新、新建、批量启动/停止
- 操作列：启动/停止、编辑、复制、查看日志、下载、删除
- 拖拽排序（对应后端 `POST /configs/reorder`）

### 8.4 新建/编辑配置 `/configs/new` `/configs/:id/edit`
- 7 个 tab，完全对齐老 Windows 系统 + 后端 schema：
  - 基本：name、serverAddr、serverPort、user、metas、natHoleStunServer
  - 认证：method (token/oidc/none) + 各自字段
  - 日志：level、maxDays、disablePrintColor
  - 管理：webServer (addr/port/user/password/tls/staticDir)、pprofEnable、autoDelete (absolute/relative/none + path/days)
  - 连接：protocol (tcp/kcp/quic/websocket/wss)、连接超时、保活、连接池、心跳、高级（DNS、源地址、quic 参数、tcpMux 等）
  - TLS：enable/serverName/certFile/keyFile/trustedCaFile/disableCustomTLSFirstByte
  - 高级：dnsServer、loginFailExit、disableAutoStart、useV1Format、metas (key-value)
- "原始 TOML"按钮可切到 raw 编辑模式（Monaco editor）
- 保存按钮 sticky 在卡片底部，未保存有黄色提示条

### 8.5 代理列表 `/configs/:id/proxies`
- 列：状态点 / 名称 / 类型 / 本地地址 / 本地端口 / 远程端口/域名 / 实时连接数 / 实时上行/下行 / 操作
- 类型用彩色 tag（tcp 蓝、udp 紫、xtcp 橙、http 绿……）
- 实时连接数/流量从 WebSocket 事件实时刷新
- 操作：编辑、启用/禁用切换、复制、删除
- 上移/下移按钮 + 拖拽排序
- 工具栏：搜索、类型筛选、新建、快速添加（dropdown 8 种类型预设）

### 8.6 新建/编辑代理 `/configs/:id/proxies/new` `/configs/:id/proxies/:name/edit`
- 顶部：名称（含「随机名称」按钮）+ 类型 dropdown（8 种）
- 类型联动：选 stcp/xtcp/sudp 时显示「角色」字段（服务端/访问者），切换角色显示不同字段
- 6 个 tab：
  - 基本：按类型变化
    - tcp/udp：localIP、localPort、remotePort
    - http/https：localIP、localPort、customDomains、subdomain、locations、httpUser/httpPwd、hostHeaderRewrite、headers、requestHeaders、responseHeaders
    - stcp/sudp/xtcp 服务端：secretKey、localIP、localPort、allowUsers
    - stcp/sudp/xtcp 访问者：serverName、serverUser、secretKey、bindAddr、bindPort、(xtcp: keepTunnelOpen、minRetryInterval 等)
    - tcpmux：customDomains、subdomain、routeByHTTPUser、multiplexer (httpconnect)
  - 高级：useEncryption、useCompression、bandwidthLimit、bandwidthLimitMode (client/server)
  - 插件（仅"客户端"代理可用）：plugin name dropdown + 各插件特有字段
    - http2http/http2https/https2http/https2https：localAddr、hostHeaderRewrite、requestHeaders
    - http_proxy：httpUser、httpPasswd
    - socks5：username、password
    - static_file：localPath、stripPrefix、httpUser、httpPassword
    - unix_domain_socket：unixPath
    - tls2raw：localAddr、crtPath、keyPath
  - 负载均衡：group、groupKey（仅 tcp/udp/http/https/tcpmux）
  - 健康检查：type (tcp/http/none) + interval/timeout/maxFailed + path (http) + httpHeaders
  - 元数据：key-value 表

### 8.7 日志页 `/configs/:id/logs`
- 顶部：日志文件下拉（最新 + 历史日期）、级别筛选、关键字搜索
- 主体：虚拟列表渲染（性能：1 万行不卡），按级别着色（debug 灰 / info 默认 / warn 黄 / error 红）
- "实时跟随"开关，开启时新日志自动滚到底
- 工具栏：清空显示 / 下载 / 暂停 / 复制选中
- WebSocket `/api/v1/configs/{id}/logs/tail` 推送

### 8.8 全局事件 `/events`
- 时间线视图（左侧时间戳 + 右侧事件卡片）
- 顶部筛选：类型多选、级别、配置归属、时间范围
- 实时模式（默认）+ 历史模式（暂停接收）
- 事件类型支持：
  - `config.started/stopped/error/reloaded`
  - `proxy.added/removed/updated/status_changed/connections`
  - `system.*`（如有）

### 8.9 系统监控 `/system`
- 4 张大图（2x2 grid）：CPU、内存、磁盘 IO、网络
- 每图：实时折线（最近 1h，可切 5m/15m/1h/24h）+ 当前值/峰值/平均
- 下方：进程信息卡（frpmgrd 自身 PID/uptime/打开文件数/goroutine 数 等，来自 `/system/process`）
- 主机信息卡（hostname、OS、kernel、arch、CPU 型号、内存大小、来自 `/system/info`）

### 8.10 工具页
**导入** `/tools/import`：
- 4 个 tab：文件 / URL / 文本（粘贴 TOML） / Zip 批量
- 解析预览：展示将创建的配置 + 冲突提示（已存在则 rename / replace / skip）
- 提交后跳新建的配置详情

**校验** `/tools/validate`：
- Monaco editor 粘贴 TOML，右侧实时显示错误（行号 + 错误描述）+ 解析后字段树

**NAT 探测** `/tools/nathole`：
- 输入 STUN 服务器 + 走「探测」按钮
- 结果显示 NAT 类型（Full Cone / Restricted / Port Restricted / Symmetric）+ 公网 IP:Port + 适配的代理类型建议

### 8.11 设置 `/settings`
- 三栏 tab：
  - 个人：主题切换、Token 重置（弹出当前 token + "复制到剪贴板"）、退出登录
  - 应用：默认启动页、轮询间隔、通知级别（off/error only/all）
  - 关于：版本号、FRP 版本、构建日期、检查更新（fetch GitHub latest release）、项目链接

## 9. 目录结构

```
webui/
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── vite.config.ts
├── index.html
├── src/
│   ├── main.tsx                  入口
│   ├── App.tsx                   Refine + Router 装配
│   ├── api/
│   │   ├── client.ts             openapi-fetch 实例 + 401 拦截
│   │   ├── schema.d.ts           openapi-typescript 生成（gitignore）
│   │   ├── dataProvider.ts       Refine dataProvider
│   │   └── events.ts             WebSocket hook
│   ├── auth/
│   │   ├── AuthContext.tsx
│   │   ├── authProvider.ts       Refine authProvider
│   │   └── LoginPage.tsx
│   ├── theme/
│   │   ├── ThemeContext.tsx
│   │   ├── tokens.ts             light + dark token 配置
│   │   └── ThemeSwitcher.tsx
│   ├── layout/
│   │   ├── MainShell.tsx
│   │   ├── AuthShell.tsx
│   │   ├── Sidebar.tsx
│   │   ├── HeaderBar.tsx
│   │   └── Breadcrumb.tsx
│   ├── components/
│   │   ├── StatusBadge.tsx
│   │   ├── ProtocolTag.tsx
│   │   ├── CopyableText.tsx
│   │   ├── DangerConfirmModal.tsx
│   │   ├── EmptyState.tsx
│   │   ├── EventToast.tsx
│   │   ├── MetricCard.tsx
│   │   └── MonacoEditor.tsx
│   ├── pages/
│   │   ├── dashboard/index.tsx
│   │   ├── configs/
│   │   │   ├── list.tsx
│   │   │   ├── edit.tsx
│   │   │   ├── form/             七个 tab 组件
│   │   │   │   ├── BasicTab.tsx
│   │   │   │   ├── AuthTab.tsx
│   │   │   │   ├── LogTab.tsx
│   │   │   │   ├── AdminTab.tsx
│   │   │   │   ├── ConnectionTab.tsx
│   │   │   │   ├── TlsTab.tsx
│   │   │   │   └── AdvancedTab.tsx
│   │   │   ├── logs.tsx
│   │   │   └── raw.tsx
│   │   ├── proxies/
│   │   │   ├── list.tsx
│   │   │   ├── edit.tsx
│   │   │   └── form/             六个 tab + 类型联动
│   │   │       ├── BasicTab.tsx
│   │   │       ├── AdvancedTab.tsx
│   │   │       ├── PluginTab.tsx
│   │   │       ├── LoadBalanceTab.tsx
│   │   │       ├── HealthCheckTab.tsx
│   │   │       └── MetadataTab.tsx
│   │   ├── events/index.tsx
│   │   ├── system/index.tsx
│   │   ├── tools/
│   │   │   ├── import.tsx
│   │   │   ├── validate.tsx
│   │   │   └── nathole.tsx
│   │   └── settings/
│   │       ├── personal.tsx
│   │       ├── app.tsx
│   │       └── about.tsx
│   ├── hooks/
│   │   ├── useEventStream.ts
│   │   ├── useLogTail.ts
│   │   └── usePolling.ts
│   ├── utils/
│   │   ├── format.ts             流量/时长/字节数格式化
│   │   ├── proxy-types.ts        类型枚举 + 默认值
│   │   └── plugin-types.ts       插件枚举 + 字段映射
│   └── constants.ts
└── public/
    └── favicon.svg

internal/api/
└── webui.go                      go:embed 静态资源服务
```

## 10. 构建集成

`webui/package.json` scripts：
- `dev`：vite，端口 5173，代理 /api → 8080
- `build`：tsc --noEmit + vite build → 输出到 `webui/dist/`
- `gen:api`：openapi-typescript ../internal/api/openapi.yaml -o src/api/schema.d.ts

Go 端 `internal/api/webui.go`：

```go
//go:embed all:webui/dist
var webuiFS embed.FS

// Mount 到 chi router 的 root，要排在 /api 之后避免劫持
func mountWebUI(r chi.Router) {
    sub, _ := fs.Sub(webuiFS, "webui/dist")
    fileServer := http.FileServer(http.FS(sub))
    r.Get("/*", spaHandler(sub, fileServer))
}
```

Makefile 新增：
- `make webui-install`：cd webui && pnpm install
- `make webui-build`：cd webui && pnpm run build
- `make build`：webui-build && go build（保证嵌入最新产物）

`.gitignore` 增加 `webui/node_modules/`、`webui/dist/`、`webui/src/api/schema.d.ts`。

## 11. 错误处理 + UX 提示

- **API 错误**：openapi-fetch middleware 捕获非 2xx → 拆出 backend 返回的 `{error: string, code: string}` → 统一 toast。
- **网络错误**：抛 `<NetworkErrorBanner>`（顶部红条 + "重试" 按钮）。
- **WebSocket 断开**：右下角浮窗 "实时连接已断开，正在重连…"，重连成功后 1.5s 自动消失。
- **表单校验**：antd Form 内联红字 + 提交时 scrollToFirstError。
- **删除/危险**：`<DangerConfirmModal>` 输入名称匹配才能确认。
- **空态**：每个列表页有专属 `<EmptyState>`（带图标 + 操作 CTA）。

## 12. 实施分期

**M1 - 脚手架与基础设施**
- Vite + React + TS + antd + Refine 初始化
- openapi-typescript 生成 schema
- openapi-fetch 客户端
- AuthContext + LoginPage + 401 拦截
- ThemeContext + 亮暗切换
- MainShell + AuthShell + 路由骨架
- go:embed 静态服务 + Makefile

**M2 - CRUD 核心**
- Configs 列表/新建/编辑（7 tab）
- Proxies 列表/新建/编辑（6 tab + 类型联动 + 8 种代理 + 9 种插件）
- 原始 TOML 编辑（Monaco）
- 排序、拖拽、批量操作

**M3 - 实时与监控**
- WebSocket 事件流接入
- Dashboard
- Logs（虚拟列表 + tail）
- Events 全局事件中心
- System 监控页（4 图 + 进程/主机卡）

**M4 - 工具与设置**
- 导入（4 种来源）
- 校验
- NAT 探测
- Settings + About + 检查更新

**M5 - 打磨**
- 全局错误处理统一
- Loading 骨架屏
- 空态文案
- 可访问性（键盘导航、ARIA）
- README + 截图

## 13. 不做的事（YAGNI）

- 多用户/RBAC——后端是单 token，单管理员
- i18n——仅中文
- 移动端响应式——管理后台桌面优先，<768px 仅保证不破，不优化
- PWA / 离线——服务器侧应用没必要
- 自带 frps 安装/部署——超出 frpmgr 范畴
- 自动化测试（单元/E2E）——首期不写，靠类型安全 + 人工冒烟

## 14. 安全注意

- token 存在 localStorage 而非 cookie，XSS 可读取——接受这个权衡（个人/小团队管理工具，部署在内网）。
- 不引入会执行远程脚本的依赖。
- Monaco editor 不开放任意 JS 执行。
- CSP 头由 Go 端在静态资源响应里设置：`default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline';`
