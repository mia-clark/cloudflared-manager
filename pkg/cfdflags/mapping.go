package cfdflags

import (
	"fmt"
	"sort"
	"strings"
)

// Options is the decoupled input shape for ToTunnelEnv. The PR-04
// internal/process layer is responsible for projecting a
// pkg/cfdconfig.TunnelConfigV1 onto this struct before invoking the
// mapping. The duplication is intentional: cfdflags must not import
// cfdconfig (would create a back-edge in the dependency graph).
type Options struct {
	Protocol          string
	EdgeIPVersion     string
	EdgeBindAddress   string
	Region            string
	PostQuantum       bool
	Retries           int
	GracePeriod       string
	LogLevel          string
	TransportLogLevel string
	Tags              map[string]string

	// Label is handled separately by the caller (see LabelArgv) because
	// it has no TUNNEL_LABEL env var upstream.
	Label string

	// AdvancedEnvOverrides flows through verbatim after dropping
	// reserved keys. See whitelist.go.
	AdvancedEnvOverrides map[string]string
}

// ToTunnelEnv maps Options onto the TUNNEL_* env vars cloudflared
// understands. Empty / zero values are skipped so the child process
// inherits cloudflared upstream defaults for those slots.
//
// The cfdmgrd-mandated env (TUNNEL_TOKEN, NO_AUTOUPDATE, TUNNEL_METRICS,
// TUNNEL_OUTPUT) is NOT set here — the spawn helper injects those after
// merging the user env so they always win.
func ToTunnelEnv(o Options) map[string]string {
	out := make(map[string]string, 16)

	if o.Protocol != "" {
		out["TUNNEL_TRANSPORT_PROTOCOL"] = o.Protocol
	}
	if o.EdgeIPVersion != "" {
		out["TUNNEL_EDGE_IP_VERSION"] = o.EdgeIPVersion
	}
	if o.EdgeBindAddress != "" {
		out["TUNNEL_EDGE_BIND_ADDRESS"] = o.EdgeBindAddress
	}
	if o.Region != "" {
		out["TUNNEL_REGION"] = o.Region
	}
	if o.PostQuantum {
		out["TUNNEL_POST_QUANTUM"] = "true"
	}
	if o.Retries > 0 {
		out["TUNNEL_RETRIES"] = fmt.Sprintf("%d", o.Retries)
	}
	if o.GracePeriod != "" {
		out["TUNNEL_GRACE_PERIOD"] = o.GracePeriod
	}
	if o.LogLevel != "" {
		out["TUNNEL_LOGLEVEL"] = o.LogLevel
	}
	if o.TransportLogLevel != "" {
		out["TUNNEL_TRANSPORT_LOGLEVEL"] = o.TransportLogLevel
	}
	if t := formatTags(o.Tags); t != "" {
		out["TUNNEL_TAG"] = t
	}
	for k, v := range o.AdvancedEnvOverrides {
		if AllowEnvOverride(k) {
			out[k] = v
		}
	}
	return out
}

// LabelArgv returns the argv fragment cfdmgrd should append to the
// cloudflared command for the connector label. cloudflared does NOT
// expose a TUNNEL_LABEL env var, so this is the one place we cannot
// avoid argv. Returns nil when label is empty.
func LabelArgv(label string) []string {
	label = strings.TrimSpace(label)
	if label == "" {
		return nil
	}
	return []string{"--label", label}
}

// formatTags joins a tag map into the comma-separated "k1=v1,k2=v2"
// format cloudflared expects for TUNNEL_TAG. Keys are sorted to keep
// the output deterministic across runs (useful for test snapshots and
// for diffing the environment in audit logs).
func formatTags(tags map[string]string) string {
	if len(tags) == 0 {
		return ""
	}
	keys := make([]string, 0, len(tags))
	for k := range tags {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+tags[k])
	}
	return strings.Join(parts, ",")
}
