package manager

import "testing"

func TestParseHandshake_OK(t *testing.T) {
	line := "FRPS_WORKER_READY addr=127.0.0.1:54321 user=abc pass=deadbeef"
	hs, ok := parseHandshake(line)
	if !ok {
		t.Fatal("expected ok")
	}
	if hs.Addr != "127.0.0.1:54321" || hs.User != "abc" || hs.Pass != "deadbeef" {
		t.Fatalf("got %+v", hs)
	}
}

func TestParseHandshake_Reject(t *testing.T) {
	// frps 自身的日志行（实测会先于握手出现在 stdout），必须被拒绝。
	if _, ok := parseHandshake("2026-06-04 [I] frps tcp listen on 0.0.0.0:17000"); ok {
		t.Fatal("expected reject for frps log line")
	}
	if _, ok := parseHandshake("some random line"); ok {
		t.Fatal("expected reject")
	}
}

func TestParseHandshake_MissingAddr(t *testing.T) {
	if _, ok := parseHandshake("FRPS_WORKER_READY user=abc pass=def"); ok {
		t.Fatal("expected reject when addr missing")
	}
}
