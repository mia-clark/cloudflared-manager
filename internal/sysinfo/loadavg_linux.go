//go:build linux

package sysinfo

import (
	"github.com/shirou/gopsutil/v4/load"
)

func loadAverage() ([3]float64, error) {
	a, err := load.Avg()
	if err != nil {
		return [3]float64{}, err
	}
	return [3]float64{a.Load1, a.Load5, a.Load15}, nil
}
