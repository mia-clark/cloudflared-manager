// Package cfdupdate keeps the cloudflared binary current with little or no
// operator involvement: it bootstraps a binary on first boot, periodically
// checks the upstream release proxy, downloads + verifies new versions, and
// (in full-auto mode) activates them and rolling-restarts the running
// instances that follow the active version — rolling back automatically if a
// new binary fails to come up healthy.
//
// The package owns the behaviour only; persistence of its settings is injected
// (the daemon stores them in meta.json) and instance restarts go through an
// injected controller, so cfdupdate carries no dependency on the manager
// package (no import cycle) and is straightforward to unit-test with fakes.
package cfdupdate

import (
	"os"
	"strconv"
	"strings"
)

// Update modes. full = download+activate+restart automatically; download =
// fetch+verify in the background but wait for a manual apply; notify = only
// surface that an update exists.
const (
	ModeFull     = "full"
	ModeDownload = "download"
	ModeNotify   = "notify"
)

// Settings is the operator-tunable auto-update configuration. JSON tags are
// the snake_case API/meta contract.
type Settings struct {
	Enabled            bool   `json:"enabled"`
	Mode               string `json:"mode"`
	IntervalHours      int    `json:"interval_hours"`
	IncludePrerelease  bool   `json:"include_prerelease"`
	AutoRollback       bool   `json:"auto_rollback"`
	KeepVersions       int    `json:"keep_versions"`
	HealthGraceSeconds int    `json:"health_grace_seconds"`
}

// Default knob values, mirrored in the spec and docs. Used when no env var is
// set and meta.json has never recorded a config.
const (
	defEnabled       = true
	defMode          = ModeFull
	defIntervalHours = 24
	defPrerelease    = false
	defAutoRollback  = true
	defKeepVersions  = 3
	defHealthGrace   = 8
)

// DefaultSettings builds the seed configuration from env vars (falling back to
// the built-in defaults). It is only consulted when meta.json has never stored
// an auto-update block; once the UI/persisted value exists, that wins.
func DefaultSettings() Settings {
	return Settings{
		Enabled:            envBool("CFDM_CFD_AUTOUPDATE_ENABLED", defEnabled),
		Mode:               envStr("CFDM_CFD_AUTOUPDATE_MODE", defMode),
		IntervalHours:      envInt("CFDM_CFD_AUTOUPDATE_INTERVAL_HOURS", defIntervalHours),
		IncludePrerelease:  envBool("CFDM_CFD_AUTOUPDATE_PRERELEASE", defPrerelease),
		AutoRollback:       envBool("CFDM_CFD_AUTOUPDATE_ROLLBACK", defAutoRollback),
		KeepVersions:       envInt("CFDM_CFD_AUTOUPDATE_KEEP", defKeepVersions),
		HealthGraceSeconds: envInt("CFDM_CFD_AUTOUPDATE_HEALTH_GRACE", defHealthGrace),
	}.Normalized()
}

// Normalized clamps every field into its valid range and canonicalises mode.
// An unknown/empty mode collapses to full so a typo never silently disables
// restarts.
func (s Settings) Normalized() Settings {
	s.Mode = strings.ToLower(strings.TrimSpace(s.Mode))
	switch s.Mode {
	case ModeFull, ModeDownload, ModeNotify:
	default:
		s.Mode = ModeFull
	}
	s.IntervalHours = clampInt(s.IntervalHours, 1, 720)       // 1h .. 30d
	s.KeepVersions = clampInt(s.KeepVersions, 0, 50)          // 0 = no pruning
	s.HealthGraceSeconds = clampInt(s.HealthGraceSeconds, 1, 120)
	return s
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func envStr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envBool(key string, def bool) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on", "y":
		return true
	case "0", "false", "no", "off", "n":
		return false
	default:
		return def
	}
}
