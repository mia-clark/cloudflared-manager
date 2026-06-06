package cfdconfig

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// Validate runs syntactic and enumeration checks on a TunnelConfigV1.
// It deliberately does NOT cross-validate against pkg/cfdflags business
// rules (e.g. "postQuantum requires protocol == quic") — that lives in
// the API validate layer where both packages are available.
//
// A nil receiver returns ErrNilConfig; callers should treat that as
// "fresh / empty draft" rather than a hard error.
func (c *TunnelConfigV1) Validate() error {
	if c == nil {
		return ErrNilConfig
	}
	if err := validateToken(c.Token); err != nil {
		return fmt.Errorf("token: %w", err)
	}
	if err := c.Edge.validate(); err != nil {
		return fmt.Errorf("edge: %w", err)
	}
	if err := c.Reliability.validate(); err != nil {
		return fmt.Errorf("reliability: %w", err)
	}
	if err := c.Logging.validate(); err != nil {
		return fmt.Errorf("logging: %w", err)
	}
	if err := c.Identity.validate(); err != nil {
		return fmt.Errorf("identity: %w", err)
	}
	if err := validateAdvancedEnv(c.AdvancedEnvOverrides); err != nil {
		return fmt.Errorf("advancedEnvOverrides: %w", err)
	}
	return nil
}

// ErrNilConfig is returned by Validate on a nil receiver.
var ErrNilConfig = errors.New("cfdconfig: nil config")

// ---- token ----

// tokenRE accepts the full base64 alphabet (both standard `+` `/` and
// url-safe `_` `-` variants) plus padding `=`. cloudflared tokens are
// standard base64-encoded JSON; the inner JSON is opaque to us here.
var tokenRE = regexp.MustCompile(`^[A-Za-z0-9_\-+/=]+$`)

func validateToken(t string) error {
	if t == "" {
		return nil // empty token = "not yet provisioned"; allowed in drafts
	}
	if n := len(t); n < 100 || n > 1500 {
		return fmt.Errorf("length %d outside [100, 1500]", n)
	}
	if !tokenRE.MatchString(t) {
		return errors.New("contains non-base64 characters")
	}
	return nil
}

// ---- edge ----

var validProtocols = map[string]bool{"": true, "auto": true, "http2": true, "quic": true}
var validEdgeIPVersions = map[string]bool{"": true, "auto": true, "4": true, "6": true}
var validRegions = map[string]bool{"": true, "us": true}

func (e EdgeConfig) validate() error {
	if !validProtocols[e.Protocol] {
		return fmt.Errorf("protocol %q not in {auto,http2,quic}", e.Protocol)
	}
	if !validEdgeIPVersions[e.EdgeIPVersion] {
		return fmt.Errorf("edgeIpVersion %q not in {auto,4,6}", e.EdgeIPVersion)
	}
	if !validRegions[e.Region] {
		return fmt.Errorf("region %q not in {\"\",us}", e.Region)
	}
	// EdgeBindAddress: best-effort syntactic check; cloudflared itself
	// rejects malformed values at start, so we only filter obvious junk.
	if a := strings.TrimSpace(e.EdgeBindAddress); a != "" {
		if strings.ContainsAny(a, " \t\n\r") {
			return fmt.Errorf("edgeBindAddress contains whitespace: %q", e.EdgeBindAddress)
		}
	}
	return nil
}

// ---- reliability ----

func (r ReliabilityConfig) validate() error {
	// 0 is allowed and means "unset → use cloudflared default (5)".
	// Negative or > 20 are misuse: cloudflared's upstream cap is much
	// higher but values above 20 indicate the user mistook this knob
	// for an inactivity timeout.
	if r.Retries < 0 || r.Retries > 20 {
		return fmt.Errorf("retries %d outside [0, 20] (0 = use cloudflared default)", r.Retries)
	}
	if gp := strings.TrimSpace(r.GracePeriod); gp != "" {
		d, err := time.ParseDuration(gp)
		if err != nil {
			return fmt.Errorf("gracePeriod %q not a duration: %w", gp, err)
		}
		if d < time.Second || d > 5*time.Minute {
			return fmt.Errorf("gracePeriod %s outside [1s, 5m]", d)
		}
	}
	return nil
}

// ---- logging ----

var validLogLevels = map[string]bool{
	"":      true,
	"debug": true, "info": true, "warn": true, "error": true, "fatal": true,
}

func (l LoggingConfig) validate() error {
	if !validLogLevels[strings.ToLower(l.LogLevel)] {
		return fmt.Errorf("logLevel %q not in {debug,info,warn,error,fatal}", l.LogLevel)
	}
	if !validLogLevels[strings.ToLower(l.TransportLogLevel)] {
		return fmt.Errorf("transportLogLevel %q not in {debug,info,warn,error,fatal}", l.TransportLogLevel)
	}
	return nil
}

// ---- identity ----

var labelRE = regexp.MustCompile(`^[A-Za-z0-9_\-\. ]+$`)
var tagKeyRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func (i IdentityConfig) validate() error {
	if l := i.Label; l != "" {
		if len(l) > 64 {
			return fmt.Errorf("label length %d > 64", len(l))
		}
		if !labelRE.MatchString(l) {
			return fmt.Errorf("label %q contains illegal characters", l)
		}
	}
	for k, v := range i.Tags {
		if k == "" || len(k) > 32 {
			return fmt.Errorf("tag key %q length out of [1,32]", k)
		}
		if !tagKeyRE.MatchString(k) {
			return fmt.Errorf("tag key %q does not match [A-Za-z_][A-Za-z0-9_]*", k)
		}
		if len(v) > 128 {
			return fmt.Errorf("tag %s value length %d > 128", k, len(v))
		}
	}
	return nil
}

// ---- advanced env overrides ----

// reservedEnv is the subset of TUNNEL_* / NO_AUTOUPDATE keys cfdmgrd
// itself injects at spawn time and which users MUST NOT override via
// AdvancedEnvOverrides — overriding would either nuke the token, allow
// cloudflared to self-update behind cfdmgrd's back, or hide metrics
// behind a port we can't scrape.
var reservedEnv = map[string]bool{
	"TUNNEL_TOKEN":        true,
	"NO_AUTOUPDATE":       true,
	"AUTOUPDATE_FREQ":     true,
	"TUNNEL_METRICS":      true,
	"TUNNEL_OUTPUT":       true,
	"TUNNEL_LOGFILE":      true,
	"TUNNEL_LOGDIRECTORY": true,
}

var envKeyRE = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)

func validateAdvancedEnv(env map[string]string) error {
	for k := range env {
		if !envKeyRE.MatchString(k) {
			return fmt.Errorf("env key %q must match ^[A-Z][A-Z0-9_]*$", k)
		}
		if reservedEnv[k] {
			return fmt.Errorf("env key %q is reserved by cfdmgrd", k)
		}
	}
	return nil
}
