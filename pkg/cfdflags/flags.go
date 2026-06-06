// Package cfdflags provides metadata about every cloudflared CLI flag
// the manager UI is willing to expose, together with the mapping from
// our YAML / JSON config tree onto the TUNNEL_* environment variables
// the cloudflared subprocess actually consumes.
//
// Three rules govern this package:
//
//  1. token-mode only — flags that only matter for `tunnel login` /
//     `route` / quick tunnels / origin config (ingress, proxy-*-timeout
//     etc.) are NOT modelled here. Those configurations live in the
//     Cloudflare Zero Trust dashboard.
//  2. env > argv — every modelled flag declares its TUNNEL_* env name
//     so cfdmgrd can inject values into the child process env. The one
//     documented exception is the connector label (no TUNNEL_LABEL env
//     exists upstream); see Mapping for how it is handled.
//  3. cfdmgrd-mandated env is reserved — TUNNEL_TOKEN / NO_AUTOUPDATE
//     / TUNNEL_METRICS / TUNNEL_OUTPUT are always set by cfdmgrd
//     itself and rejected from AdvancedEnvOverrides.
package cfdflags

// Group identifies the UI tab a flag belongs to in the configuration
// form. The values double as i18n keys.
type Group string

const (
	GroupEdge        Group = "edge"
	GroupReliability Group = "reliability"
	GroupLogging     Group = "logging"
	GroupIdentity    Group = "identity"
	GroupAdvanced    Group = "advanced"
)

// ControlKind drives the kind of widget rendered for each flag.
type ControlKind string

const (
	ControlSelect   ControlKind = "select"
	ControlSwitch   ControlKind = "switch"
	ControlNumber   ControlKind = "number"
	ControlText     ControlKind = "text"
	ControlDuration ControlKind = "duration"
	ControlChips    ControlKind = "chips"
)

// Flag describes one user-exposable flag.
type Flag struct {
	YAMLPath string      // dot path inside TunnelConfigV1, e.g. "edge.protocol"
	CLIFlag  string      // cloudflared CLI flag including dashes, e.g. "--protocol"
	EnvName  string      // TUNNEL_* env var; empty means "argv only" (Label)
	Group    Group       // UI group
	Control  ControlKind // widget kind
	Enum     []string    // non-nil for ControlSelect
	Default  string      // textual default for documentation
	HelpText string      // one-liner shown under the widget
	Advanced bool        // hidden behind a "show advanced" toggle
}

// All returns the full set of modelled flags in display order. The
// slice is freshly allocated per call so callers may mutate it safely.
func All() []Flag {
	out := make([]Flag, len(registry))
	copy(out, registry)
	return out
}

// ByEnvName indexes registry by EnvName, skipping flags whose EnvName
// is empty (currently just identity.label). Result is a fresh map.
func ByEnvName() map[string]Flag {
	m := make(map[string]Flag, len(registry))
	for _, f := range registry {
		if f.EnvName != "" {
			m[f.EnvName] = f
		}
	}
	return m
}

// registry is the canonical metadata table. Keep it sorted by YAMLPath
// so reviews diff cleanly.
var registry = []Flag{
	{
		YAMLPath: "edge.protocol",
		CLIFlag:  "--protocol",
		EnvName:  "TUNNEL_TRANSPORT_PROTOCOL",
		Group:    GroupEdge,
		Control:  ControlSelect,
		Enum:     []string{"auto", "http2", "quic"},
		Default:  "auto",
		HelpText: "Transport protocol between this connector and the Cloudflare edge.",
	},
	{
		YAMLPath: "edge.edgeIpVersion",
		CLIFlag:  "--edge-ip-version",
		EnvName:  "TUNNEL_EDGE_IP_VERSION",
		Group:    GroupEdge,
		Control:  ControlSelect,
		Enum:     []string{"auto", "4", "6"},
		Default:  "4",
		HelpText: "IP family used to reach the edge.",
	},
	{
		YAMLPath: "edge.edgeBindAddress",
		CLIFlag:  "--edge-bind-address",
		EnvName:  "TUNNEL_EDGE_BIND_ADDRESS",
		Group:    GroupEdge,
		Control:  ControlText,
		Default:  "",
		HelpText: "Pin a local source IP for outbound edge dials. Leave empty for OS default.",
		Advanced: true,
	},
	{
		YAMLPath: "edge.region",
		CLIFlag:  "--region",
		EnvName:  "TUNNEL_REGION",
		Group:    GroupEdge,
		Control:  ControlSelect,
		Enum:     []string{"", "us"},
		Default:  "",
		HelpText: "Restrict edge routing to a region. Empty = global.",
	},
	{
		YAMLPath: "edge.postQuantum",
		CLIFlag:  "--post-quantum",
		EnvName:  "TUNNEL_POST_QUANTUM",
		Group:    GroupEdge,
		Control:  ControlSwitch,
		Default:  "false",
		HelpText: "Force a post-quantum key exchange. Only effective when protocol=quic.",
		Advanced: true,
	},
	{
		YAMLPath: "reliability.retries",
		CLIFlag:  "--retries",
		EnvName:  "TUNNEL_RETRIES",
		Group:    GroupReliability,
		Control:  ControlNumber,
		Default:  "5",
		HelpText: "Number of connection / protocol retries before giving up. Range 1-20.",
	},
	{
		YAMLPath: "reliability.gracePeriod",
		CLIFlag:  "--grace-period",
		EnvName:  "TUNNEL_GRACE_PERIOD",
		Group:    GroupReliability,
		Control:  ControlDuration,
		Default:  "30s",
		HelpText: "How long to wait for in-flight requests on SIGTERM. Range 1s..5m.",
	},
	{
		YAMLPath: "logging.logLevel",
		CLIFlag:  "--loglevel",
		EnvName:  "TUNNEL_LOGLEVEL",
		Group:    GroupLogging,
		Control:  ControlSelect,
		Enum:     []string{"debug", "info", "warn", "error", "fatal"},
		Default:  "info",
		HelpText: "Application log verbosity. debug records request URLs and headers (sensitive).",
	},
	{
		YAMLPath: "logging.transportLogLevel",
		CLIFlag:  "--transport-loglevel",
		EnvName:  "TUNNEL_TRANSPORT_LOGLEVEL",
		Group:    GroupLogging,
		Control:  ControlSelect,
		Enum:     []string{"debug", "info", "warn", "error", "fatal"},
		Default:  "info",
		HelpText: "Transport (QUIC/HTTP2) log verbosity.",
		Advanced: true,
	},
	{
		YAMLPath: "identity.label",
		CLIFlag:  "--label",
		EnvName:  "", // <-- no env var upstream; argv passthrough
		Group:    GroupIdentity,
		Control:  ControlText,
		Default:  "",
		HelpText: "Connector display name shown in the Zero Trust dashboard.",
	},
	{
		YAMLPath: "identity.tags",
		CLIFlag:  "--tag",
		EnvName:  "TUNNEL_TAG",
		Group:    GroupIdentity,
		Control:  ControlChips,
		Default:  "",
		HelpText: "Key=value annotations forwarded to the dashboard.",
		Advanced: true,
	},
}
