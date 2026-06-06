// Package cfdstate defines the lifecycle states used by the manager for
// each cloudflared instance.
//
// The iota values are intentionally preserved from the previous
// pkg/consts.ConfigState typedef so that any persisted snapshot or
// existing log/event payload (which only ever emits the string form via
// the manager) continues to round-trip unambiguously across this rename.
package cfdstate

// ConfigState is the lifecycle state of a single cloudflared instance.
// The zero value (ConfigStateUnknown) is reserved for "not yet observed"
// and should not appear in normal operation.
type ConfigState int

const (
	ConfigStateUnknown ConfigState = iota
	ConfigStateStarted
	ConfigStateStopped
	ConfigStateStarting
	ConfigStateStopping
)
