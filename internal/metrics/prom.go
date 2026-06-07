package metrics

import (
	"bufio"
	"strconv"
	"strings"
)

// Sample is one (metric, labels, value) tuple decoded from the
// Prometheus text exposition format. The parser deliberately collapses
// label sets into a single canonical string ("k1=v1,k2=v2", sorted by
// key) so consumers can use it as a map key without re-stringifying.
type Sample struct {
	Name   string
	Labels map[string]string
	Value  float64
}

// ParsePromText parses one Prometheus text-format response body into a
// flat slice of Sample. Comment lines (# HELP / # TYPE) are skipped.
// Lines that fail to parse are skipped silently — callers only care
// about the well-known metric names listed in spec §5.2.
//
// The parser is deliberately minimal: it does not validate types,
// does not honour Histogram bucket semantics beyond exposing them as
// individual samples (the caller picks _count / _sum / specific _bucket
// lines as needed), and does not support exemplars.
func ParsePromText(body string) []Sample {
	out := make([]Sample, 0, 64)
	sc := bufio.NewScanner(strings.NewReader(body))
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || line[0] == '#' {
			continue
		}
		s, ok := parseOne(line)
		if !ok {
			continue
		}
		out = append(out, s)
	}
	return out
}

// parseOne decodes a single non-comment, non-empty line.
//
// Two shapes appear in cloudflared output:
//
//	metric_name 123.45
//	metric_name{label="value",other="x"} 123.45
//
// We split on the last whitespace before the numeric value so the
// "labels" segment can contain spaces inside quoted strings (rare but
// allowed by the spec).
func parseOne(line string) (Sample, bool) {
	// Find the value field — last whitespace-separated token.
	idx := strings.LastIndexAny(line, " \t")
	if idx < 0 {
		return Sample{}, false
	}
	rawValue := strings.TrimSpace(line[idx+1:])
	v, err := strconv.ParseFloat(rawValue, 64)
	if err != nil {
		return Sample{}, false
	}
	head := strings.TrimSpace(line[:idx])

	name := head
	var labels map[string]string

	// Optional label set in {...}
	if i := strings.IndexByte(head, '{'); i >= 0 {
		name = strings.TrimSpace(head[:i])
		end := strings.LastIndexByte(head, '}')
		if end < 0 || end <= i {
			return Sample{}, false
		}
		labels = parseLabels(head[i+1 : end])
	}
	if name == "" {
		return Sample{}, false
	}
	return Sample{Name: name, Labels: labels, Value: v}, true
}

// parseLabels handles k="v",k2="v2" style. Backslash escapes inside
// quoted values are unwound (\\, \" and \n only — covers cloudflared's
// usage; full escape rules are noise we don't need).
func parseLabels(seg string) map[string]string {
	m := make(map[string]string, 4)
	i := 0
	for i < len(seg) {
		// skip leading spaces and commas
		for i < len(seg) && (seg[i] == ' ' || seg[i] == ',' || seg[i] == '\t') {
			i++
		}
		if i >= len(seg) {
			break
		}
		// read key up to '='
		ks := i
		for i < len(seg) && seg[i] != '=' {
			i++
		}
		if i >= len(seg) {
			break
		}
		key := strings.TrimSpace(seg[ks:i])
		i++ // skip '='
		// value must be quoted
		if i >= len(seg) || seg[i] != '"' {
			return nil
		}
		i++ // skip opening "
		var val strings.Builder
		for i < len(seg) && seg[i] != '"' {
			if seg[i] == '\\' && i+1 < len(seg) {
				switch seg[i+1] {
				case '\\':
					val.WriteByte('\\')
				case '"':
					val.WriteByte('"')
				case 'n':
					val.WriteByte('\n')
				default:
					val.WriteByte(seg[i+1])
				}
				i += 2
				continue
			}
			val.WriteByte(seg[i])
			i++
		}
		if i < len(seg) {
			i++ // skip closing "
		}
		m[key] = val.String()
	}
	return m
}
