package selfupdate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ResetLog 截断并写头; ReadLog 读取(含 spawn 的 updater 追加的步骤); 再次 Reset 截断旧内容。
func TestUpdateLog_ResetReadAppend(t *testing.T) {
	dir := t.TempDir()
	u := New(Config{DataDir: dir})

	if got := u.ReadLog(); got != "" {
		t.Fatalf("无日志时应读到空串, got %q", got)
	}

	u.ResetLog("1.2.3", "v1.2.4")
	got := u.ReadLog()
	if !strings.Contains(got, "1.2.3") || !strings.Contains(got, "v1.2.4") {
		t.Fatalf("ResetLog 头缺少版本: %q", got)
	}

	// 模拟 spawn 出去的 updater 往同一文件追加步骤
	f, err := os.OpenFile(filepath.Join(dir, "update.log"), os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("open append: %v", err)
	}
	_, _ = f.WriteString("[*] 下载中…\n[+] 下载完成 7.1M\n")
	_ = f.Close()
	if got := u.ReadLog(); !strings.Contains(got, "[+] 下载完成 7.1M") {
		t.Fatalf("ReadLog 未含追加内容: %q", got)
	}

	// 再次 Reset 应截断旧内容
	u.ResetLog("a", "b")
	if strings.Contains(u.ReadLog(), "下载完成") {
		t.Fatalf("ResetLog 应截断旧内容")
	}
}
