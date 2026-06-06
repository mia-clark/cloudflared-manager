package cfdconfig

import (
	"bytes"
	"encoding/json"
	"fmt"

	"gopkg.in/yaml.v3"
)

// ParseYAML decodes a YAML document into a TunnelConfigV1. Unknown
// fields are tolerated (forward-compat) but malformed YAML returns an
// error. Returns a zero-valued struct if input is empty.
func ParseYAML(data []byte) (*TunnelConfigV1, error) {
	out := &TunnelConfigV1{}
	if len(bytes.TrimSpace(data)) == 0 {
		return out, nil
	}
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(false)
	if err := dec.Decode(out); err != nil {
		return nil, fmt.Errorf("cfdconfig: parse yaml: %w", err)
	}
	return out, nil
}

// MarshalYAML serialises a TunnelConfigV1 to canonical YAML. omitempty
// tags keep the on-disk file lean; nested zero-value sub-structs are
// elided entirely.
func MarshalYAML(cfg *TunnelConfigV1) ([]byte, error) {
	if cfg == nil {
		return []byte{}, nil
	}
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(cfg); err != nil {
		return nil, fmt.Errorf("cfdconfig: marshal yaml: %w", err)
	}
	_ = enc.Close()
	return buf.Bytes(), nil
}

// ParseJSON decodes a JSON object into a TunnelConfigV1. Like ParseYAML
// it tolerates unknown fields by default — strict decoding (used by
// the API helper) is done separately at the HTTP layer.
func ParseJSON(data []byte) (*TunnelConfigV1, error) {
	out := &TunnelConfigV1{}
	if len(bytes.TrimSpace(data)) == 0 {
		return out, nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return nil, fmt.Errorf("cfdconfig: parse json: %w", err)
	}
	return out, nil
}

// MarshalJSON serialises a TunnelConfigV1 to indented JSON suitable for
// log dumps; the API layer uses encoding/json directly when serving
// responses so this helper is for diagnostic / export paths only.
func MarshalJSON(cfg *TunnelConfigV1) ([]byte, error) {
	if cfg == nil {
		return []byte("null"), nil
	}
	return json.MarshalIndent(cfg, "", "  ")
}
