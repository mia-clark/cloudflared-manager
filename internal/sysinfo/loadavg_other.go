//go:build !linux

package sysinfo

import "errors"

// loadAverage is unavailable outside Linux; the API contract is that the
// caller treats this as a non-fatal "no data" condition.
func loadAverage() ([3]float64, error) {
	return [3]float64{}, errors.New("load average not supported on this platform")
}
