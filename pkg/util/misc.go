package util

import (
	"fmt"
	"strings"
)

func GetMapWithoutPrefix(set map[string]string, prefix string) map[string]string {
	m := make(map[string]string)

	for key, value := range set {
		if strings.HasPrefix(key, prefix) {
			m[strings.TrimPrefix(key, prefix)] = value
		}
	}

	if len(m) == 0 {
		return nil
	}

	return m
}

// MoveSlice moves the element s[i] to index j in s.
func MoveSlice[S ~[]E, E any](s S, i, j int) {
	x := s[i]
	if i < j {
		copy(s[i:j], s[i+1:j+1])
	} else if i > j {
		copy(s[j+1:i+1], s[j:i])
	}
	s[j] = x
}

// ByteCountIEC converts a size in bytes to a human-readable string in IEC (binary) format.
func ByteCountIEC(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB",
		float64(b)/float64(div), "KMGTPE"[exp])
}
