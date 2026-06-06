// 服务端配置可视化表单的辅助工具与字段映射。
//
// 字段精确拼写来源（v0.69.1）：
//   github.com/fatedier/frp/pkg/config/v1/server.go
//   github.com/fatedier/frp/pkg/config/v1/common.go
//
// 关键陷阱：后端 decodeJSON 启用 DisallowUnknownFields。任何空字段/空对象都
// 不能直接发送（空对象本身不会触发 unknown，但发了用户没填的值会污染配置）。
// pruneEmpty 会递归剪掉：undefined / null / '' / NaN / 空数组 / 空对象。

/** 递归剪掉空字段。返回 undefined 表示该值整体应被丢弃。 */
export function pruneEmpty<T>(value: T): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    return value.length === 0 ? undefined : value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const arr = value
      .map((v) => pruneEmpty(v))
      .filter((v) => v !== undefined);
    return arr.length === 0 ? undefined : (arr as unknown as T);
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let hasField = false;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const pv = pruneEmpty(v);
      if (pv !== undefined) {
        out[k] = pv;
        hasField = true;
      }
    }
    return hasField ? (out as unknown as T) : undefined;
  }
  return value;
}

/** 把三态字符串（'' / 'true' / 'false'）或 boolean 转回 *bool 指针。
 * 在 antd Select 中以字符串承载，提交前转回 boolean 或丢弃。 */
export function tristateBool(v: unknown): boolean | undefined {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return undefined;
}

/** 反向：把后端 *bool（true/false/缺失）映射成表单 Select 用的字符串。 */
export function tristateString(v: unknown): string {
  if (v === true) return 'true';
  if (v === false) return 'false';
  return '';
}

/** 把一个空端口范围数组（既无 start 又无 single）剪掉。 */
export interface PortsRangeRow {
  start?: number;
  end?: number;
  single?: number;
}
export function normalizePortsRanges(rows: PortsRangeRow[] | undefined): PortsRangeRow[] | undefined {
  if (!rows || rows.length === 0) return undefined;
  const out: PortsRangeRow[] = [];
  for (const r of rows) {
    if (typeof r.single === 'number' && Number.isFinite(r.single) && r.single > 0) {
      out.push({ single: r.single });
      continue;
    }
    if (typeof r.start === 'number' && Number.isFinite(r.start) && r.start > 0) {
      const end = typeof r.end === 'number' && Number.isFinite(r.end) && r.end >= r.start ? r.end : r.start;
      out.push({ start: r.start, end });
      continue;
    }
    // 无效行：跳过
  }
  return out.length === 0 ? undefined : out;
}

/** 表单的扁平字段集合。提交时由 buildServerConfigPayload 折叠为嵌套对象。 */
export interface ServerFullFormValues {
  // 实例元数据
  name?: string;
  manualStart?: boolean;

  // 基础
  bindAddr?: string;
  bindPort?: number;
  proxyBindAddr?: string;
  kcpBindPort?: number;
  quicBindPort?: number;
  tcpmuxHTTPConnectPort?: number;
  tcpmuxPassthrough?: boolean;
  // 三态 *bool：'' / 'true' / 'false'
  detailedErrorsToClient?: string;

  // auth.*
  authMethod?: 'token' | 'oidc' | '';
  authToken?: string;
  authAdditionalScopes?: string[];
  authOidcIssuer?: string;
  authOidcAudience?: string;
  authOidcSkipExpiryCheck?: boolean;
  authOidcSkipIssuerCheck?: boolean;

  // transport.*  — *bool 字段同样用字符串三态
  transportTcpMux?: string;
  transportTcpMuxKeepaliveInterval?: number;
  transportTcpKeepalive?: number;
  transportMaxPoolCount?: number;
  transportHeartbeatTimeout?: number;
  transportQuicKeepalivePeriod?: number;
  transportQuicMaxIdleTimeout?: number;
  transportQuicMaxIncomingStreams?: number;
  transportTlsForce?: boolean;
  transportTlsCertFile?: string;
  transportTlsKeyFile?: string;
  transportTlsTrustedCaFile?: string;

  // vhost / 4xx
  vhostHTTPPort?: number;
  vhostHTTPSPort?: number;
  vhostHTTPTimeout?: number;
  subDomainHost?: string;
  custom404Page?: string;

  // 端口白名单与限制
  allowPorts?: PortsRangeRow[];
  maxPortsPerClient?: number;

  // SSH 网关
  sshBindPort?: number;
  sshPrivateKeyFile?: string;
  sshAutoGenPrivateKeyPath?: string;
  sshAuthorizedKeysFile?: string;

  // 日志
  logLevel?: string;
  logMaxDays?: number;
  logTo?: string;
  logDisablePrintColor?: boolean;

  // 高级
  udpPacketSize?: number;
  userConnTimeout?: number;
  natholeAnalysisDataReserveHours?: number;
}

/** 已剪枝、可直接 PUT 给后端的 nested ServerConfig 对象。 */
export interface BuiltServerConfig {
  [key: string]: unknown;
}

/** 把表单值折叠为后端 ServerConfig 形状，剪掉所有空字段/空对象。 */
export function buildServerConfigPayload(v: ServerFullFormValues): BuiltServerConfig {
  // auth.additionalScopes：去掉空串
  const additionalScopes = (v.authAdditionalScopes ?? []).filter((s) => typeof s === 'string' && s.length > 0);

  const auth = {
    method: v.authMethod || undefined,
    token: v.authMethod === 'token' ? v.authToken : undefined,
    additionalScopes: additionalScopes.length === 0 ? undefined : additionalScopes,
    oidc: v.authMethod === 'oidc' ? {
      issuer: v.authOidcIssuer,
      audience: v.authOidcAudience,
      skipExpiryCheck: v.authOidcSkipExpiryCheck === true ? true : undefined,
      skipIssuerCheck: v.authOidcSkipIssuerCheck === true ? true : undefined,
    } : undefined,
  };

  const transport = {
    tcpMux: tristateBool(v.transportTcpMux),
    tcpMuxKeepaliveInterval: v.transportTcpMuxKeepaliveInterval,
    tcpKeepalive: v.transportTcpKeepalive,
    maxPoolCount: v.transportMaxPoolCount,
    heartbeatTimeout: v.transportHeartbeatTimeout,
    quic: {
      keepalivePeriod: v.transportQuicKeepalivePeriod,
      maxIdleTimeout: v.transportQuicMaxIdleTimeout,
      maxIncomingStreams: v.transportQuicMaxIncomingStreams,
    },
    tls: {
      force: v.transportTlsForce === true ? true : undefined,
      certFile: v.transportTlsCertFile,
      keyFile: v.transportTlsKeyFile,
      trustedCaFile: v.transportTlsTrustedCaFile,
    },
  };

  const log = {
    level: v.logLevel,
    maxDays: v.logMaxDays,
    to: v.logTo,
    disablePrintColor: v.logDisablePrintColor === true ? true : undefined,
  };

  const sshTunnelGateway = {
    bindPort: v.sshBindPort,
    privateKeyFile: v.sshPrivateKeyFile,
    autoGenPrivateKeyPath: v.sshAutoGenPrivateKeyPath,
    authorizedKeysFile: v.sshAuthorizedKeysFile,
  };

  const rawCfg: Record<string, unknown> = {
    // 基础
    bindAddr: v.bindAddr,
    bindPort: v.bindPort,
    proxyBindAddr: v.proxyBindAddr,
    kcpBindPort: v.kcpBindPort,
    quicBindPort: v.quicBindPort,
    tcpmuxHTTPConnectPort: v.tcpmuxHTTPConnectPort,
    tcpmuxPassthrough: v.tcpmuxPassthrough === true ? true : undefined,
    detailedErrorsToClient: tristateBool(v.detailedErrorsToClient),

    // vhost
    vhostHTTPPort: v.vhostHTTPPort,
    vhostHTTPSPort: v.vhostHTTPSPort,
    vhostHTTPTimeout: v.vhostHTTPTimeout,
    subDomainHost: v.subDomainHost,
    custom404Page: v.custom404Page,

    // 端口白名单
    allowPorts: normalizePortsRanges(v.allowPorts),
    maxPortsPerClient: v.maxPortsPerClient,

    // 高级
    udpPacketSize: v.udpPacketSize,
    userConnTimeout: v.userConnTimeout,
    natholeAnalysisDataReserveHours: v.natholeAnalysisDataReserveHours,

    // 嵌套子树
    auth,
    transport,
    log,
    sshTunnelGateway,
  };

  return (pruneEmpty(rawCfg) ?? {}) as BuiltServerConfig;
}

/**
 * 可视化表单**管理**的全部顶层字段。保存合并时，需要先把这些 key 从
 * 旧 envelope.config 中删除，再 spread built — 否则用户在表单清空字段时，
 * 因为 pruneEmpty 把空 key 剪掉了，merge 会让 baseCfg 中的旧值"残留"，
 * 视觉上的"清空"实际未生效。
 *
 * **不在此列**的字段（webServer / metadatas / httpPlugins / enablePrometheus
 * 等）会通过 baseCfg 原样保留 — 它们由 TOML 编辑器或 worker 接管。
 */
export const MANAGED_TOP_KEYS: ReadonlySet<string> = new Set([
  // 基础
  'bindAddr', 'bindPort', 'proxyBindAddr',
  'kcpBindPort', 'quicBindPort',
  'tcpmuxHTTPConnectPort', 'tcpmuxPassthrough',
  'detailedErrorsToClient',
  // vhost
  'vhostHTTPPort', 'vhostHTTPSPort', 'vhostHTTPTimeout', 'subDomainHost', 'custom404Page',
  // 端口白名单
  'allowPorts', 'maxPortsPerClient',
  // 高级
  'udpPacketSize', 'userConnTimeout', 'natholeAnalysisDataReserveHours',
  // 嵌套子树（整体由表单管理；若整子树被剪掉则旧子树也应清空，所以列入）
  'auth', 'transport', 'log', 'sshTunnelGateway',
]);

/**
 * 把表单产物 built 与旧 envelope.config 合并为提交 payload。
 *
 * 策略：先从 baseCfg 中删除所有 MANAGED_TOP_KEYS（这样用户清空字段就真生效），
 * 再 spread built。结果：
 *   - 表单管理的字段 → 完全由 built 决定（清空 = 不出现 = Go 收到时用零值，字段被清空）
 *   - 表单不管理的字段（webServer / metadatas / httpPlugins / enablePrometheus 等）→ 从 baseCfg 透传
 */
export function mergeServerConfig(
  baseCfg: Record<string, unknown> | undefined | null,
  built: Record<string, unknown>,
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(baseCfg ?? {}) };
  for (const k of MANAGED_TOP_KEYS) {
    delete base[k];
  }
  return { ...base, ...built };
}

/** 从 ServerConfig 回填扁平表单值。允许 cfg 为空，全部字段返回 undefined。 */
export function flattenServerConfig(cfg: Record<string, unknown> | undefined | null): ServerFullFormValues {
  const c = cfg ?? {};
  const auth = ((c['auth'] as Record<string, unknown>) || {});
  const oidc = ((auth['oidc'] as Record<string, unknown>) || {});
  const transport = ((c['transport'] as Record<string, unknown>) || {});
  const quic = ((transport['quic'] as Record<string, unknown>) || {});
  const tls = ((transport['tls'] as Record<string, unknown>) || {});
  const log = ((c['log'] as Record<string, unknown>) || {});
  const ssh = ((c['sshTunnelGateway'] as Record<string, unknown>) || {});

  const allow = (c['allowPorts'] as PortsRangeRow[] | undefined);

  return {
    bindAddr: c['bindAddr'] as string | undefined,
    bindPort: c['bindPort'] as number | undefined,
    proxyBindAddr: c['proxyBindAddr'] as string | undefined,
    kcpBindPort: c['kcpBindPort'] as number | undefined,
    quicBindPort: c['quicBindPort'] as number | undefined,
    tcpmuxHTTPConnectPort: c['tcpmuxHTTPConnectPort'] as number | undefined,
    tcpmuxPassthrough: c['tcpmuxPassthrough'] as boolean | undefined,
    detailedErrorsToClient: tristateString(c['detailedErrorsToClient']),

    authMethod: (auth['method'] as 'token' | 'oidc' | '' | undefined) ?? 'token',
    authToken: auth['token'] as string | undefined,
    authAdditionalScopes: auth['additionalScopes'] as string[] | undefined,
    authOidcIssuer: oidc['issuer'] as string | undefined,
    authOidcAudience: oidc['audience'] as string | undefined,
    authOidcSkipExpiryCheck: oidc['skipExpiryCheck'] as boolean | undefined,
    authOidcSkipIssuerCheck: oidc['skipIssuerCheck'] as boolean | undefined,

    transportTcpMux: tristateString(transport['tcpMux']),
    transportTcpMuxKeepaliveInterval: transport['tcpMuxKeepaliveInterval'] as number | undefined,
    transportTcpKeepalive: transport['tcpKeepalive'] as number | undefined,
    transportMaxPoolCount: transport['maxPoolCount'] as number | undefined,
    transportHeartbeatTimeout: transport['heartbeatTimeout'] as number | undefined,
    transportQuicKeepalivePeriod: quic['keepalivePeriod'] as number | undefined,
    transportQuicMaxIdleTimeout: quic['maxIdleTimeout'] as number | undefined,
    transportQuicMaxIncomingStreams: quic['maxIncomingStreams'] as number | undefined,
    transportTlsForce: tls['force'] as boolean | undefined,
    transportTlsCertFile: tls['certFile'] as string | undefined,
    transportTlsKeyFile: tls['keyFile'] as string | undefined,
    transportTlsTrustedCaFile: tls['trustedCaFile'] as string | undefined,

    vhostHTTPPort: c['vhostHTTPPort'] as number | undefined,
    vhostHTTPSPort: c['vhostHTTPSPort'] as number | undefined,
    vhostHTTPTimeout: c['vhostHTTPTimeout'] as number | undefined,
    subDomainHost: c['subDomainHost'] as string | undefined,
    custom404Page: c['custom404Page'] as string | undefined,

    allowPorts: Array.isArray(allow) ? allow : undefined,
    maxPortsPerClient: c['maxPortsPerClient'] as number | undefined,

    sshBindPort: ssh['bindPort'] as number | undefined,
    sshPrivateKeyFile: ssh['privateKeyFile'] as string | undefined,
    sshAutoGenPrivateKeyPath: ssh['autoGenPrivateKeyPath'] as string | undefined,
    sshAuthorizedKeysFile: ssh['authorizedKeysFile'] as string | undefined,

    logLevel: (log['level'] as string | undefined) ?? 'info',
    logMaxDays: log['maxDays'] as number | undefined,
    logTo: log['to'] as string | undefined,
    logDisablePrintColor: log['disablePrintColor'] as boolean | undefined,

    udpPacketSize: c['udpPacketSize'] as number | undefined,
    userConnTimeout: c['userConnTimeout'] as number | undefined,
    natholeAnalysisDataReserveHours: c['natholeAnalysisDataReserveHours'] as number | undefined,
  };
}
