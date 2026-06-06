// 手写的前后端契约类型。
//
// 来源（权威）：
//   - internal/api/configs.go        (configEnvelope / createReq)
//   - internal/manager/instance.go   (Snapshot, snake_case JSON 标签)
//   - internal/manager/manager.go    (MgrMeta, camelCase JSON 标签)
//   - pkg/config/server.go + 上游 v1.ServerConfig (ServerConfig, camelCase)
//
// 注意混合风格（本项目第一大坑）：
//   - Snapshot          → snake_case (last_error / started_at / stopped_at)
//   - MgrMeta           → camelCase  (manualStart)
//   - ServerConfig      → camelCase  (vhostHTTPPort 不是 vhostHttpPort)
//
// 不要凭驼峰直觉猜字段名，逐字对照 Go 源。

// 实例运行时快照（internal/manager/instance.go: Snapshot，snake_case）。
export interface Snapshot {
  id: string;
  name: string;
  path: string;       // toml 配置文件绝对路径
  log_path: string;   // 管理器接管该实例 worker 输出的日志文件路径
  state: 'stopped' | 'starting' | 'started' | 'stopping';
  last_error?: string;
  started_at?: string;
  stopped_at?: string;
}

// 管理器元数据（internal/manager/manager.go: MgrMeta，camelCase）。
export interface MgrMeta {
  name: string;
  manualStart: boolean;
}

// frps 服务端配置（上游 v1.ServerConfig 子集，camelCase）。
// GET 回来的 config 会带 Complete() 后的全量字段，这里仅声明 UI 需要的最小子集，
// 其余未知字段用索引签名原样保留（透传回 PUT 时不丢）。
//
// 字段精确拼写依据：
//   $(go env GOMODCACHE)/github.com/fatedier/frp@v0.69.1/pkg/config/v1/server.go
//   $(go env GOMODCACHE)/github.com/fatedier/frp@v0.69.1/pkg/config/v1/common.go
//
// 上游不规则缩写陷阱（写错就废，Go json 大小写不敏感虽能写入但回读拿不到）：
//   server.go:46  VhostHTTPPort   `json:"vhostHTTPPort"`
//   server.go:58  TCPMuxHTTPConnectPort `json:"tcpmuxHTTPConnectPort"`
//   server.go:94  NatHoleAnalysisDataReserveHours `json:"natholeAnalysisDataReserveHours"`
//   server.go:209 AutoGenPrivateKeyPath `json:"autoGenPrivateKeyPath"`
//   server.go:168 TCPKeepAlive `json:"tcpKeepalive"`（注意小写 a）

export interface PortsRange {
  start?: number;
  end?: number;
  single?: number;
}

export interface TLSConfigFields {
  certFile?: string;
  keyFile?: string;
  trustedCaFile?: string;
  serverName?: string;
}

export interface ServerTransportTLS extends TLSConfigFields {
  force?: boolean;
}

export interface QUICOptions {
  keepalivePeriod?: number;
  maxIdleTimeout?: number;
  maxIncomingStreams?: number;
}

export interface ServerTransport {
  // *bool 指针字段：true / false / 未设；未设时不应发送字段（pruneEmpty 处理）。
  tcpMux?: boolean | null;
  tcpMuxKeepaliveInterval?: number;
  tcpKeepalive?: number; // JSON 标签 `tcpKeepalive`，小写 a
  maxPoolCount?: number;
  heartbeatTimeout?: number;
  quic?: QUICOptions;
  tls?: ServerTransportTLS;
  [key: string]: unknown;
}

export interface AuthOIDC {
  issuer?: string;
  audience?: string;
  skipExpiryCheck?: boolean;
  skipIssuerCheck?: boolean;
  [key: string]: unknown;
}

export interface SSHTunnelGateway {
  bindPort?: number;
  privateKeyFile?: string;
  autoGenPrivateKeyPath?: string;
  authorizedKeysFile?: string;
  [key: string]: unknown;
}

export interface WebServerInfo {
  addr?: string;
  port?: number;
  user?: string;
  password?: string;
  pprofEnable?: boolean;
  assetsDir?: string;
  tls?: TLSConfigFields;
  [key: string]: unknown;
}

export interface LogConfigFields {
  to?: string;
  level?: string;
  maxDays?: number;
  disablePrintColor?: boolean;
  [key: string]: unknown;
}

export interface ServerConfig {
  // —— 基础监听 ——
  bindAddr?: string;
  bindPort?: number;
  kcpBindPort?: number;
  quicBindPort?: number;
  proxyBindAddr?: string;
  tcpmuxHTTPConnectPort?: number;
  tcpmuxPassthrough?: boolean;

  // —— 虚拟主机 ——
  vhostHTTPPort?: number;
  vhostHTTPSPort?: number;
  vhostHTTPTimeout?: number;
  subDomainHost?: string;
  custom404Page?: string;

  // —— 端口白名单 / 限制 ——
  allowPorts?: PortsRange[];
  maxPortsPerClient?: number;

  // —— 高级 ——
  udpPacketSize?: number;
  userConnTimeout?: number;
  natholeAnalysisDataReserveHours?: number;
  // *bool 指针：可能为 null/未设。
  detailedErrorsToClient?: boolean | null;
  enablePrometheus?: boolean;

  // —— 嵌套子树 ——
  auth?: {
    method?: 'token' | 'oidc' | '';
    token?: string;
    additionalScopes?: string[];
    oidc?: AuthOIDC;
    [key: string]: unknown;
  };
  transport?: ServerTransport;
  webServer?: WebServerInfo;
  log?: LogConfigFields;
  sshTunnelGateway?: SSHTunnelGateway;

  // —— 上游 Complete() 会补全大量字段，原样保留。 ——
  [key: string]: unknown;
}

// GET /configs/{id} 等接口的响应信封：Snapshot 全部字段 + config + frpsmgr。
export interface ConfigEnvelope extends Snapshot {
  config: ServerConfig;
  frpsmgr: MgrMeta;
}

// 列表响应。
export interface ConfigList {
  items: Snapshot[];
}

// POST /validate 响应。
export interface ValidateResp {
  valid: boolean;
  errors?: string[];
  warnings?: string[];
}

// ── 运行时监控（GET /api/v1/runtime/{id}/*）──────────────────────────────
// 这些端点是 internal/api/runtime.go 把 frps 进程 loopback webServer 的原生 JSON
// 原样转发回来的，因此一律是 frps 原生 camelCase（非 Snapshot 的 snake_case）。
// 字段逐字对照 frps /api/serverinfo、/api/proxy/{type}、/api/clients 的实际形状；
// 多数字段在客户端未连接 / 类型缺省时可能缺失，故均标 optional，使用前 `??` 兜底。

// GET /api/v1/runtime/{id}/overview → frps /api/serverinfo (camelCase)。
export interface RuntimeOverview {
  version?: string;
  bindPort?: number;
  vhostHTTPPort?: number;
  vhostHTTPSPort?: number;
  kcpBindPort?: number;
  quicBindPort?: number;
  subdomainHost?: string;
  maxPoolCount?: number;
  maxPortsPerClient?: number;
  heartbeatTimeout?: number;
  totalTrafficIn?: number;
  totalTrafficOut?: number;
  curConns?: number;
  clientCounts?: number;
  proxyTypeCount?: Record<string, number>;
}

// GET /api/v1/runtime/{id}/proxies → { proxies: RuntimeProxy[] }，元素为 frps 原生代理信息。
export interface RuntimeProxy {
  name: string;
  type?: string;
  status?: string;
  clientVersion?: string;
  todayTrafficIn?: number;
  todayTrafficOut?: number;
  curConns?: number;
  lastStartTime?: string;
  lastCloseTime?: string;
  conf?: Record<string, unknown>;
}

// GET /api/v1/runtime/{id}/proxies 的响应信封。
export interface RuntimeProxyList {
  proxies: RuntimeProxy[];
}

// GET /api/v1/runtime/{id}/clients → frps 原生客户端连接数组。
// 字段以实际为准（防御式读取），常见有 runID/addr/version/connectAt。
export interface RuntimeClient {
  runID?: string;
  addr?: string;
  version?: string;
  connectAt?: string;
  [key: string]: unknown;
}

// ── 历史流量 & 告警（GET /api/v1/metrics/*、/api/v1/alerts/*）──────────────
// 权威来源：
//   - internal/metrics/store.go          (TrafficPoint，snake_case JSON 标签)
//   - internal/metrics/store_alerts.go    (AlertRule / AlertEvent，snake_case)
//   - internal/api/metrics.go             (Traffic / *Alert* handler，响应信封)
// 全部 snake_case，逐字对照 Go 源，不要改成驼峰。

// 单个流量采样点（internal/metrics/store.go: TrafficPoint）。
// in/out 是该 step 桶内的区间增量字节数；conns 是桶内瞬时连接数(max)。
// inst_id/scope/key 在响应顶层已给出，逐点也会带，标 optional。
export interface TrafficPoint {
  ts: number; // unix 秒
  in: number;
  out: number;
  conns: number;
  inst_id?: string;
  scope?: string;
  key?: string;
}

// GET /api/v1/metrics/{id}/traffic 的响应信封（internal/api/metrics.go: Traffic）。
export interface TrafficSeries {
  inst_id: string;
  scope: string;
  key: string;
  step: number;
  points: TrafficPoint[] | null;
}

// 告警规则（internal/metrics/store_alerts.go: AlertRule）。
export type AlertMetric = 'conns' | 'traffic_in_rate' | 'traffic_out_rate';
export type AlertOp = '>' | '>=' | '<' | '<=';

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  inst_id: string; // 目标实例 id，"*" 表示全部
  metric: AlertMetric;
  op: AlertOp;
  threshold: number;
  for_seconds: number; // 持续多久才触发（去抖）
  target: string; // 代理名，"" / "*" 为 server 级
  webhook: string; // 可选，触发/解除时 POST 的 URL
}

// 告警事件（internal/metrics/store_alerts.go: AlertEvent）。
export interface AlertEvent {
  id: string;
  rule_id: string;
  inst_id: string;
  target: string;
  fired_at: number; // unix 秒
  resolved_at: number; // 0 = 未解除
  value: number;
  state: 'firing' | 'resolved';
}

// 列表响应信封。
export interface AlertRuleList {
  items: AlertRule[];
}
export interface AlertEventList {
  items: AlertEvent[];
}
