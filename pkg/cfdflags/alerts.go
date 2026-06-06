package cfdflags

import "time"

// Severity classifies an alert's urgency.
type Severity string

const (
	SeverityInfo     Severity = "info"
	SeverityWarning  Severity = "warning"
	SeverityCritical Severity = "critical"
)

// AlertRuleTemplate is the metadata describing one factory-default
// alert rule. The expression column uses PromQL-flavoured pseudo-code;
// the actual evaluator in internal/metrics/sampler will translate
// against the SQLite series schema.
type AlertRuleTemplate struct {
	ID          string        // stable identifier, used as default rule_id in DB
	Name        string        // human label
	Expr        string        // PromQL-style expression (advisory)
	Threshold   string        // canonical default threshold as text
	For         time.Duration // dampening window
	Severity    Severity
	Description string
}

// DefaultAlertTemplates returns the 12 factory-default alert rules.
// The slice is freshly allocated so callers may mutate it safely.
func DefaultAlertTemplates() []AlertRuleTemplate {
	out := make([]AlertRuleTemplate, len(defaultAlertTemplates))
	copy(out, defaultAlertTemplates)
	return out
}

var defaultAlertTemplates = []AlertRuleTemplate{
	{
		ID:          "ha_degraded",
		Name:        "HA 连接不足",
		Expr:        "ha_connections < 4",
		Threshold:   "< 4",
		For:         2 * time.Minute,
		Severity:    SeverityWarning,
		Description: "默认 4 条 HA 连接，缺 1 条持续 2 分钟即告警。",
	},
	{
		ID:          "ha_disconnected",
		Name:        "HA 全部断开",
		Expr:        "ha_connections == 0",
		Threshold:   "== 0",
		For:         30 * time.Second,
		Severity:    SeverityCritical,
		Description: "0 条连接 = 隧道完全离线，对应 /ready 返回 503。",
	},
	{
		ID:          "ready_probe_failed",
		Name:        "/ready 探针失败",
		Expr:        "ready_probe_failures >= 3",
		Threshold:   ">= 3 次连续 503/超时",
		For:         0,
		Severity:    SeverityCritical,
		Description: "覆盖 metrics 端点本身挂掉的情况，与 HA 全断互为冗余。",
	},
	{
		ID:          "reconnect_storm",
		Name:        "重连风暴",
		Expr:        "rate(tunnel_register_success[5m]) > 0.1",
		Threshold:   "> 6 次/分钟",
		For:         5 * time.Minute,
		Severity:    SeverityWarning,
		Description: "稳态下 register_success 不应持续增长。",
	},
	{
		ID:          "http_5xx_ratio_high",
		Name:        "5xx 占比过高",
		Expr:        "sum(rate(resp_5xx[5m])) / sum(rate(resp_all[5m])) > 0.05",
		Threshold:   "> 5%",
		For:         5 * time.Minute,
		Severity:    SeverityWarning,
		Description: "> 20% 应升级为 critical（由 sampler 双阈值实现）。",
	},
	{
		ID:          "request_errors_high",
		Name:        "请求错误激增",
		Expr:        "rate(request_errors[5m]) > 1",
		Threshold:   "> 1 次/秒",
		For:         5 * time.Minute,
		Severity:    SeverityWarning,
		Description: "request_errors 是 cloudflared 自身无法完成的请求。",
	},
	{
		ID:          "quic_rtt_high",
		Name:        "QUIC 高 RTT",
		Expr:        "avg(smoothed_rtt) > 300",
		Threshold:   "> 300 ms",
		For:         10 * time.Minute,
		Severity:    SeverityWarning,
		Description: "smoothed_rtt 持续 > 300ms 显著影响用户体验。",
	},
	{
		ID:          "quic_packet_loss_high",
		Name:        "QUIC 丢包高",
		Expr:        "rate(lost_packets[5m]) > 5",
		Threshold:   "> 5 包/秒",
		For:         5 * time.Minute,
		Severity:    SeverityWarning,
		Description: "链路质量下降信号。",
	},
	{
		ID:          "udp_dropped_high",
		Name:        "UDP 丢报文",
		Expr:        "rate(udp_dropped_datagrams[5m]) > 1",
		Threshold:   "> 1/s",
		For:         5 * time.Minute,
		Severity:    SeverityWarning,
		Description: "仅当用户开启了 UDP / private network 时有意义。",
	},
	{
		ID:          "rss_high",
		Name:        "内存异常",
		Expr:        "process_resident_memory_bytes > 500 * 1024 * 1024",
		Threshold:   "> 500 MiB",
		For:         15 * time.Minute,
		Severity:    SeverityWarning,
		Description: "正常稳态 50-150 MiB；> 1 GiB 升级 critical。",
	},
	{
		ID:          "goroutines_high",
		Name:        "Goroutine 泄漏",
		Expr:        "go_goroutines > 5000",
		Threshold:   "> 5000",
		For:         30 * time.Minute,
		Severity:    SeverityWarning,
		Description: "正常 100-500；长期高位说明 leak。",
	},
	{
		ID:          "process_restarted",
		Name:        "进程刚重启",
		Expr:        "time() - process_start_time_seconds < 60",
		Threshold:   "< 60 s",
		For:         0,
		Severity:    SeverityInfo,
		Description: "仅记录用，与重连风暴配合识别 flapping。",
	},
}
