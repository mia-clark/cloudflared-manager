package cfdflags

// AllowEnvOverride decides whether a key from
// TunnelConfigV1.AdvancedEnvOverrides may be injected into the child
// process environment. The policy:
//
//   - any modelled TUNNEL_* flag's EnvName is allowed (so users can
//     express the same setting via the escape hatch if they prefer);
//   - a small additional allowlist of "advanced but harmless" TUNNEL_*
//     vars is included for compat with debugging scenarios;
//   - anything cfdmgrd manages itself (TUNNEL_TOKEN, NO_AUTOUPDATE,
//     TUNNEL_METRICS, TUNNEL_OUTPUT, TUNNEL_LOGFILE, TUNNEL_LOGDIRECTORY,
//     AUTOUPDATE_FREQ) is REJECTED;
//   - everything else is rejected.
func AllowEnvOverride(envName string) bool {
	if reservedOverride[envName] {
		return false
	}
	if modelledEnv[envName] {
		return true
	}
	if extraAllowed[envName] {
		return true
	}
	return false
}

// reservedOverride contains keys cfdmgrd injects itself; users must
// not be able to override them via AdvancedEnvOverrides.
var reservedOverride = map[string]bool{
	"TUNNEL_TOKEN":        true,
	"NO_AUTOUPDATE":       true,
	"AUTOUPDATE_FREQ":     true,
	"TUNNEL_METRICS":      true,
	"TUNNEL_OUTPUT":       true,
	"TUNNEL_LOGFILE":      true,
	"TUNNEL_LOGDIRECTORY": true,
}

// modelledEnv is populated lazily from registry on first use; the
// invariant "every Flag.EnvName not in reservedOverride is allowed"
// keeps the data sources in sync.
var modelledEnv = func() map[string]bool {
	m := make(map[string]bool, len(registry))
	for _, f := range registry {
		if f.EnvName != "" && !reservedOverride[f.EnvName] {
			m[f.EnvName] = true
		}
	}
	return m
}()

// extraAllowed names env vars that don't correspond to a modelled flag
// but are sometimes useful for power users. Keep this list short.
var extraAllowed = map[string]bool{
	"TUNNEL_DNS_RESOLVER_ADDRS":     true, // cloudflared 2025.7+ custom resolver list
	"TUNNEL_METRICS_UPDATE_FREQ":    true, // metrics scrape interval (display only)
	"TUNNEL_MANAGEMENT_DIAGNOSTICS": true, // enable /debug/pprof through CF mgmt
}
