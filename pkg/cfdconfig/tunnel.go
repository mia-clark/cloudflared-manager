// Package cfdconfig defines the local-side configuration model for a
// single cloudflared instance managed by cfdmgrd.
//
// The model deliberately covers ONLY the parameters the connector
// process consumes when invoked as `cloudflared tunnel run --token ...`.
// All ingress / public-hostname / origin-side settings live in the
// Cloudflare Zero Trust dashboard and are NOT modelled here.
//
// YAML is the on-disk format (one .yaml file per instance under
// $DATA_DIR/profiles/). JSON is used over the HTTP API. Both encodings
// share the same tag set (camelCase) so a config round-trips through
// either without re-shaping.
package cfdconfig

// TunnelConfigV1 is the v1 schema. Major shape changes should bump to a
// new struct (TunnelConfigV2) and migrate, never silently widen this one.
type TunnelConfigV1 struct {
	// Token is the cloudflared connector token. Highly sensitive.
	// API responses that include the full Config envelope MUST strip
	// this field by default; see internal/api/configs.go for the read
	// path. The dedicated GET /configs/{id}/token endpoint serves a
	// masked form.
	Token string `yaml:"token,omitempty" json:"token,omitempty"`

	Edge        EdgeConfig        `yaml:"edge,omitempty" json:"edge,omitempty"`
	Reliability ReliabilityConfig `yaml:"reliability,omitempty" json:"reliability,omitempty"`
	Logging     LoggingConfig     `yaml:"logging,omitempty" json:"logging,omitempty"`
	Identity    IdentityConfig    `yaml:"identity,omitempty" json:"identity,omitempty"`

	// AdvancedEnvOverrides is the user escape hatch for cloudflared env
	// vars not modelled above. Values are merged into the child process
	// env at spawn time AFTER the cfdmgrd-mandated env (TUNNEL_TOKEN /
	// NO_AUTOUPDATE / TUNNEL_METRICS / TUNNEL_OUTPUT), so user overrides
	// CANNOT clobber those. The list of permitted keys is enforced by
	// pkg/cfdflags.AllowEnvOverride.
	AdvancedEnvOverrides map[string]string `yaml:"advancedEnvOverrides,omitempty" json:"advancedEnvOverrides,omitempty"`

	// BinaryVersion pins the cloudflared binary version used by this
	// instance. Empty / "current" = follow the global active version.
	// A concrete tag (e.g. "2026.5.2") pins independently for canary or
	// rollback purposes. The pkg/cfdbin package (added in PR-05) is
	// responsible for resolving this to a real path.
	BinaryVersion string `yaml:"binaryVersion,omitempty" json:"binaryVersion,omitempty"`
}

// EdgeConfig groups parameters that influence how cloudflared reaches
// the Cloudflare edge network.
type EdgeConfig struct {
	// Protocol selects the transport between cloudflared and the edge.
	// "auto" (default) prefers QUIC and falls back to HTTP/2; "quic"
	// and "http2" force the choice. Anything else is rejected by
	// Validate.
	Protocol string `yaml:"protocol,omitempty" json:"protocol,omitempty"`

	// EdgeIPVersion picks the IP family used to dial the edge.
	// "auto" defers to the OS; "4" / "6" forces. Default empty == "4"
	// upstream.
	EdgeIPVersion string `yaml:"edgeIpVersion,omitempty" json:"edgeIpVersion,omitempty"`

	// EdgeBindAddress optionally pins the local source IP for outbound
	// edge connections. Its IP family overrides EdgeIPVersion when set.
	EdgeBindAddress string `yaml:"edgeBindAddress,omitempty" json:"edgeBindAddress,omitempty"`

	// Region restricts the edge routing region. Currently the only
	// non-empty value cloudflared accepts is "us". Empty means global.
	Region string `yaml:"region,omitempty" json:"region,omitempty"`

	// PostQuantum forces a post-quantum key exchange with the edge.
	// Only effective when Protocol == "quic"; Validate rejects it with
	// any other protocol because cloudflared itself errors out at boot.
	PostQuantum bool `yaml:"postQuantum,omitempty" json:"postQuantum,omitempty"`
}

// ReliabilityConfig groups retry / shutdown behavior.
type ReliabilityConfig struct {
	// Retries is the maximum number of connection / protocol retries
	// before giving up. cloudflared defaults to 5 with exponential
	// backoff (1s, 2s, 4s, 8s, 16s). Validate accepts 1..20; the
	// upstream is unbounded but values above 20 indicate misuse.
	Retries int `yaml:"retries,omitempty" json:"retries,omitempty"`

	// GracePeriod is the duration cloudflared waits for in-flight
	// requests to finish after receiving SIGINT/SIGTERM before exiting.
	// A second matching signal short-circuits the wait. Values are
	// parsed as Go time.Duration strings ("30s", "2m", etc.). Default
	// upstream is 30s.
	GracePeriod string `yaml:"gracePeriod,omitempty" json:"gracePeriod,omitempty"`
}

// LoggingConfig controls cloudflared's two log levels. The destination
// stream and format (JSON via --output) are decided by cfdmgrd itself
// and NOT modelled here on purpose: ProcessTailer relies on stderr +
// JSON for structured parsing.
type LoggingConfig struct {
	// LogLevel controls application-level events (default "info").
	// Accepted: debug, info, warn, error, fatal.
	LogLevel string `yaml:"logLevel,omitempty" json:"logLevel,omitempty"`

	// TransportLogLevel controls QUIC/HTTP2 transport events
	// separately. Same vocabulary as LogLevel.
	TransportLogLevel string `yaml:"transportLogLevel,omitempty" json:"transportLogLevel,omitempty"`
}

// IdentityConfig holds connector-identity hints reported back to the
// Cloudflare Zero Trust dashboard.
type IdentityConfig struct {
	// Label is the connector display name. Limited to a small charset
	// by Validate. Note: cloudflared has no TUNNEL_LABEL env var, so
	// this is the ONE field cfdmgrd passes through argv at spawn time.
	Label string `yaml:"label,omitempty" json:"label,omitempty"`

	// Tags is a free-form key→value annotation set that propagates to
	// the dashboard. cloudflared accepts these via TUNNEL_TAG as a
	// comma-joined "k1=v1,k2=v2" string.
	Tags map[string]string `yaml:"tags,omitempty" json:"tags,omitempty"`
}
