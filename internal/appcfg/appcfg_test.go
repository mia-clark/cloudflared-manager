package appcfg

import "testing"

// TestNormalizeListenAddr pins the CFDM_HTTP_ADDR normalization contract:
// bare port -> ":port"; existing host:port pass through; everything we cannot
// confidently interpret is returned as-is WITH a warning (fail-fast, so
// net.Listen reports a real error instead of silently binding the default).
func TestNormalizeListenAddr(t *testing.T) {
	cases := []struct {
		in       string
		wantAddr string
		wantWarn bool
	}{
		// empty -> default, no warning
		{"", ":8080", false},
		// bare port -> prepend colon
		{"8080", ":8080", false},
		{"18085", ":18085", false},
		{" 9001 ", ":9001", false}, // trimmed first
		{"1", ":1", false},
		{"65535", ":65535", false},
		// already host:port -> unchanged, no warning (backward compatible)
		{":8080", ":8080", false},
		{"0.0.0.0:8080", "0.0.0.0:8080", false},
		{"127.0.0.1:8080", "127.0.0.1:8080", false},
		{"192.168.1.1:18085", "192.168.1.1:18085", false},
		{"[::]:8080", "[::]:8080", false},
		{"[::1]:9000", "[::1]:9000", false},
		{"localhost:8080", "localhost:8080", false}, // syntactically valid; bind may still fail
		// out-of-range bare port -> as-is + warn
		{"0", "0", true},
		{"70000", "70000", true},
		{"65536", "65536", true},
		// colon present but port invalid -> as-is + warn
		{":0", ":0", true},
		{":99999", ":99999", true},
		// unrecognized -> as-is + warn
		{"abc", "abc", true},
		{"8080/tcp", "8080/tcp", true},
		{"192.168.1.1", "192.168.1.1", true},             // bare IP, missing port
		{"2001:db8::1:8080", "2001:db8::1:8080", true},   // unbracketed IPv6 -> too many colons
		{"８０８０", "８０８０", true},                             // full-width digits must NOT be treated as a port
	}
	for _, c := range cases {
		gotAddr, gotWarn := NormalizeListenAddr(c.in)
		if gotAddr != c.wantAddr {
			t.Errorf("NormalizeListenAddr(%q) addr = %q, want %q", c.in, gotAddr, c.wantAddr)
		}
		if (gotWarn != "") != c.wantWarn {
			t.Errorf("NormalizeListenAddr(%q) warn=%q, wantWarn=%v", c.in, gotWarn, c.wantWarn)
		}
	}
}

// TestIsAllASCIIDigits guards the ASCII-only digit check that keeps full-width
// digits out of the bare-port branch.
func TestIsAllASCIIDigits(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"", false},
		{"0", true},
		{"18085", true},
		{"18085a", false},
		{" 18085", false},
		{"-1", false},
		{"８０８０", false}, // full-width
	}
	for _, c := range cases {
		if got := isAllASCIIDigits(c.in); got != c.want {
			t.Errorf("isAllASCIIDigits(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}
