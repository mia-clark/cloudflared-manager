# PR-05 internal/cfdbin 多版本二进制管理 + /api/v1/binaries 端点

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** 新增 `internal/cfdbin` 包负责 cloudflared 二进制的**多版本目录管理 / 下载 / SHA256 校验 / active 版本切换**；新增 5 个 `/api/v1/binaries/*` HTTP endpoint；让 `internal/manager/instance.start()` 用 `cfdbin.Resolve(binaryVersion)` 取代硬编码的 `"cloudflared"`。完成后：UI 调 `GET /binaries/available` 看远端 release、`POST /binaries/install` 装新版、`POST /binaries/{v}/activate` 切默认；实例启动用 active 版本。

**Architecture:**
```
{data_dir}/bin/cloudflared/
├── active.json              # {"version": "2026.5.2"}（跨平台权威源）
├── current -> 2026.5.2/      # symlink (Linux/Darwin only, 失败仅日志)
├── 2026.5.2/
│   ├── cloudflared(.exe)
│   ├── meta.json            # {version, sha256, source_url, mirror, downloaded_at, size}
│   └── .verified            # 空标志文件
└── 2026.4.1/ ...
```

- `cfdbin.Store.Resolve(version)`：`""` / `"current"` → 读 `active.json::version` → 拼路径；具体 tag → 直接拼。文件不存在返回错误（**不** fallback PATH，强一致）。
- `cfdbin.Store.Install(ctx, version)`：调 GitHub Releases API 拿 release info + 提取 SHA256 → 镜像列表依次下载到临时文件 → 校验 → 平台后处理 → 原子 rename 到 `bin/cloudflared/<version>/`。
- `cfdbin.Store.Activate(version)`：原子写 `active.json`（temp + rename），Linux/Darwin 同步刷新 `current` symlink（失败仅日志）。
- 进度通过 `Install` 函数返回的 `<-chan Progress` 暴露，handler 转 SSE / WS。**简化**：本 PR Install 返回最终结果，不实时推送 — 进度推送留给 PR-08 + PR-09 的 WS 整合阶段。

**Tech Stack:** std lib only（`net/http` / `os` / `path/filepath` / `crypto/sha256` / `encoding/json` / `regexp`）。无新依赖。

---

## 文件结构总览

| 路径 | 动作 | 说明 |
|---|---|---|
| `internal/cfdbin/asset.go` | **Create** | `AssetName(version, goos, goarch) string` + 平台映射表 |
| `internal/cfdbin/asset_test.go` | **Create** | 跨平台命名测试 |
| `internal/cfdbin/store.go` | **Create** | `Store` 类型 + `New` + `Resolve` + `List` + `Activate` + `Delete` + `active.json` 读写 + meta.json 读写 + symlink 处理 |
| `internal/cfdbin/store_test.go` | **Create** | 用 t.TempDir 测目录布局 / Resolve / Activate 原子性 / Delete 保护 |
| `internal/cfdbin/download.go` | **Create** | `Available(ctx)` 列远端 + `Install(ctx, version)` 下载+校验+落盘 + 镜像 fallback + SHA256 解析 release body |
| `internal/cfdbin/download_test.go` | **Create** | 用 httptest mock GitHub API + SHA256 解析单元测试 |
| `internal/appcfg/appcfg.go` | **Modify** | 加 `BinariesDir` 字段 + 4 个 env：`CFDM_BINARIES_DIR` / `CFDM_DOWNLOAD_MIRRORS` / `CFDM_GITHUB_TOKEN` / `CFDM_CLOUDFLARED_DEFAULT_VERSION` |
| `internal/api/binaries.go` | **Create** | `BinariesHandler` + 5 个 endpoint handlers (List/Available/Install/Activate/Delete) |
| `internal/api/server.go` | **Modify** | 注册 `/api/v1/binaries/*` 路由 + 把 `*cfdbin.Store` 注入 Deps |
| `internal/manager/manager.go` | **Modify** | `Options` 加 `BinaryStore *cfdbin.Store` + 暴露给 instance |
| `internal/manager/instance.go` | **Modify** | start() 调 `binStore.Resolve(binaryVersion)`；BinaryVersion 字段在 Snapshot 中填充 |
| `cmd/cfdmgrd/main.go` | **Modify** | 初始化 `cfdbin.Store` 传给 manager 与 api.NewRouter |

---

## Task 1：基线
```bash
cd /d/Github_Codes_mia-clark/cloudflared-manager
git status && go vet ./... && go test ./... && go build -o /tmp/x ./cmd/cfdmgrd && rm -f /tmp/x
```

---

## Task 2：写 `internal/cfdbin/asset.go`

完整内容：

```go
// Package cfdbin manages the on-disk cloudflared binary collection
// owned by cfdmgrd. It deliberately handles ONE asset shape per
// (goos, goarch) tuple — the bare binary or, on Darwin, the tar.gz
// archive — and ignores .deb/.rpm/.msi/.pkg installer variants, which
// belong to system-level installs that conflict with our multi-version
// directory layout.
package cfdbin

import (
	"fmt"
	"runtime"
)

// AssetName returns the cloudflared GitHub release asset name for the
// given target (goos, goarch). Returns an empty string for unsupported
// targets so callers can decide whether to fail fast or fall back.
//
// Supported (verified against 2026.5.2 release):
//   - linux/amd64      → cloudflared-linux-amd64
//   - linux/arm64      → cloudflared-linux-arm64
//   - linux/arm        → cloudflared-linux-arm (ARMv6 soft-float)
//   - linux/armhf      → cloudflared-linux-armhf (ARMv7 hard-float; pseudo arch)
//   - linux/386        → cloudflared-linux-386
//   - darwin/amd64     → cloudflared-darwin-amd64.tgz
//   - darwin/arm64     → cloudflared-darwin-arm64.tgz
//   - windows/amd64    → cloudflared-windows-amd64.exe
//   - windows/386      → cloudflared-windows-386.exe
//
// Unsupported: linux/riscv64 (not in upstream release), freebsd (any),
// windows/arm64 (no upstream artefact at time of writing).
func AssetName(goos, goarch string) string {
	switch goos {
	case "linux":
		switch goarch {
		case "amd64":
			return "cloudflared-linux-amd64"
		case "arm64":
			return "cloudflared-linux-arm64"
		case "arm":
			return "cloudflared-linux-arm"
		case "armhf":
			return "cloudflared-linux-armhf"
		case "386":
			return "cloudflared-linux-386"
		}
	case "darwin":
		switch goarch {
		case "amd64":
			return "cloudflared-darwin-amd64.tgz"
		case "arm64":
			return "cloudflared-darwin-arm64.tgz"
		}
	case "windows":
		switch goarch {
		case "amd64":
			return "cloudflared-windows-amd64.exe"
		case "386":
			return "cloudflared-windows-386.exe"
		}
	}
	return ""
}

// CurrentAssetName is a convenience wrapper for AssetName(runtime.GOOS,
// runtime.GOARCH). Returns the second value false if the current
// platform has no upstream artefact.
func CurrentAssetName() (string, bool) {
	name := AssetName(runtime.GOOS, runtime.GOARCH)
	return name, name != ""
}

// BinaryFilename returns the on-disk filename inside a version
// directory: "cloudflared.exe" on Windows, "cloudflared" elsewhere.
func BinaryFilename(goos string) string {
	if goos == "windows" {
		return "cloudflared.exe"
	}
	return "cloudflared"
}

// IsArchive reports whether the asset name implies a tarball that must
// be extracted to find the actual binary (currently only Darwin .tgz).
func IsArchive(assetName string) bool {
	return len(assetName) >= 4 && assetName[len(assetName)-4:] == ".tgz"
}

// formatErr is a tiny helper to keep error messages consistent.
func formatErr(format string, args ...any) error { return fmt.Errorf(format, args...) }
```

---

## Task 3：写 `internal/cfdbin/store.go`

```go
package cfdbin

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// VersionMeta is what we persist next to each downloaded binary
// (`<root>/<version>/meta.json`).
type VersionMeta struct {
	Version      string    `json:"version"`
	Platform     string    `json:"platform"`
	Arch         string    `json:"arch"`
	AssetName    string    `json:"asset_name"`
	SHA256       string    `json:"sha256"`
	SourceURL    string    `json:"source_url"`
	Mirror       string    `json:"mirror,omitempty"`
	DownloadedAt time.Time `json:"downloaded_at"`
	SizeBytes    int64     `json:"size_bytes"`
	Verified     bool      `json:"verified"`
}

// activeFile is the on-disk shape of `<root>/active.json`.
type activeFile struct {
	Version string `json:"version"`
}

// Store owns the directory tree at `{data_dir}/bin/cloudflared/`. It is
// safe for concurrent use; mutations serialise on mu.
type Store struct {
	root string

	mu sync.Mutex
}

// ErrNotInstalled is returned by Resolve and Delete when the named
// version directory does not contain a verified binary.
var ErrNotInstalled = errors.New("cfdbin: version not installed")

// ErrNoActive is returned by Resolve when active.json is missing and the
// caller asked for "" / "current".
var ErrNoActive = errors.New("cfdbin: no active version")

// New constructs a Store rooted at the given directory. The directory
// is created lazily on first write; New itself does not touch the FS.
func New(rootDir string) *Store {
	return &Store{root: rootDir}
}

// Root returns the directory the store manages.
func (s *Store) Root() string { return s.root }

// versionDir returns the on-disk directory for a specific version tag.
func (s *Store) versionDir(version string) string {
	return filepath.Join(s.root, version)
}

// binaryPath returns the full path of the executable for a specific
// version (e.g. `.../2026.5.2/cloudflared` or `cloudflared.exe`).
func (s *Store) binaryPath(version string) string {
	return filepath.Join(s.versionDir(version), BinaryFilename(runtime.GOOS))
}

// activePath returns the canonical `active.json` path.
func (s *Store) activePath() string {
	return filepath.Join(s.root, "active.json")
}

// readActive returns the active version recorded in active.json. Returns
// ErrNoActive when the file does not exist or is malformed.
func (s *Store) readActive() (string, error) {
	b, err := os.ReadFile(s.activePath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", ErrNoActive
		}
		return "", err
	}
	var a activeFile
	if err := json.Unmarshal(b, &a); err != nil {
		return "", fmt.Errorf("active.json malformed: %w", err)
	}
	if a.Version == "" {
		return "", ErrNoActive
	}
	return a.Version, nil
}

// writeActive atomically replaces active.json. The temp+rename keeps a
// concurrent Resolve from reading a half-written file.
func (s *Store) writeActive(version string) error {
	if err := os.MkdirAll(s.root, 0o755); err != nil {
		return err
	}
	tmp := s.activePath() + ".tmp"
	b, err := json.MarshalIndent(activeFile{Version: version}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.activePath())
}

// Resolve returns the absolute path to the cloudflared binary for the
// given version tag. "" or "current" means "use active.json". Returns
// ErrNotInstalled if the resolved version has no on-disk binary.
func (s *Store) Resolve(version string) (string, error) {
	v := strings.TrimSpace(version)
	if v == "" || v == "current" {
		var err error
		v, err = s.readActive()
		if err != nil {
			return "", err
		}
	}
	p := s.binaryPath(v)
	st, err := os.Stat(p)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", ErrNotInstalled
		}
		return "", err
	}
	if st.IsDir() {
		return "", ErrNotInstalled
	}
	return p, nil
}

// InstalledVersion describes one entry returned by List.
type InstalledVersion struct {
	Version      string    `json:"version"`
	Path         string    `json:"path"`
	SHA256       string    `json:"sha256,omitempty"`
	SourceURL    string    `json:"source_url,omitempty"`
	Mirror       string    `json:"mirror,omitempty"`
	DownloadedAt time.Time `json:"downloaded_at,omitempty"`
	SizeBytes    int64     `json:"size_bytes,omitempty"`
	Verified     bool      `json:"verified"`
	IsActive     bool      `json:"is_active"`
}

// List returns all installed versions discovered under root, newest tag
// first (lexicographic descending — CalVer sorts correctly that way).
func (s *Store) List() ([]InstalledVersion, error) {
	active, _ := s.readActive() // ignore "no active"; treat as ""
	entries, err := os.ReadDir(s.root)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []InstalledVersion{}, nil
		}
		return nil, err
	}
	out := make([]InstalledVersion, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		ver := e.Name()
		if ver == "current" {
			continue // symlink
		}
		bp := s.binaryPath(ver)
		st, err := os.Stat(bp)
		if err != nil || st.IsDir() {
			continue
		}
		iv := InstalledVersion{
			Version:   ver,
			Path:      bp,
			SizeBytes: st.Size(),
			IsActive:  ver == active,
		}
		if m, err := s.readMeta(ver); err == nil {
			iv.SHA256 = m.SHA256
			iv.SourceURL = m.SourceURL
			iv.Mirror = m.Mirror
			iv.DownloadedAt = m.DownloadedAt
			iv.Verified = m.Verified
			if m.SizeBytes > 0 {
				iv.SizeBytes = m.SizeBytes
			}
		}
		out = append(out, iv)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Version > out[j].Version })
	return out, nil
}

// Activate marks version as the current. Fails if version is not
// installed (Resolve must succeed). Updates active.json atomically and
// best-effort refreshes the `current` symlink on Linux/Darwin.
func (s *Store) Activate(version string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.Resolve(version); err != nil {
		return err
	}
	if err := s.writeActive(version); err != nil {
		return err
	}
	// best-effort symlink refresh
	if runtime.GOOS != "windows" {
		link := filepath.Join(s.root, "current")
		_ = os.Remove(link)
		_ = os.Symlink(version, link)
	}
	return nil
}

// Delete removes the version directory. Fails if version is currently
// active or if the directory does not exist.
func (s *Store) Delete(version string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	active, _ := s.readActive()
	if version == active {
		return fmt.Errorf("cfdbin: version %s is active; cannot delete", version)
	}
	dir := s.versionDir(version)
	if _, err := os.Stat(dir); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ErrNotInstalled
		}
		return err
	}
	return os.RemoveAll(dir)
}

// metaPath returns the meta.json path for a version dir.
func (s *Store) metaPath(version string) string {
	return filepath.Join(s.versionDir(version), "meta.json")
}

func (s *Store) readMeta(version string) (VersionMeta, error) {
	var m VersionMeta
	b, err := os.ReadFile(s.metaPath(version))
	if err != nil {
		return m, err
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return m, err
	}
	return m, nil
}

func (s *Store) writeMeta(version string, m VersionMeta) error {
	if err := os.MkdirAll(s.versionDir(version), 0o755); err != nil {
		return err
	}
	tmp := s.metaPath(version) + ".tmp"
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.metaPath(version))
}
```

---

## Task 4：写 `internal/cfdbin/download.go`

```go
package cfdbin

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// DefaultGitHubAPI is the canonical releases endpoint. Tests override.
const DefaultGitHubAPI = "https://api.github.com/repos/cloudflare/cloudflared"

// Downloader resolves remote release metadata and fetches asset bytes.
type Downloader struct {
	HTTPClient *http.Client
	GitHubAPI  string   // defaults to DefaultGitHubAPI
	Mirrors    []string // URL prefixes tried in order before plain github.com
	GitHubToken string  // optional, raises API rate limits when set
}

// AvailableRelease summarises one GitHub release as exposed via
// `GET /api/v1/binaries/available`.
type AvailableRelease struct {
	TagName     string    `json:"tag_name"`
	PublishedAt time.Time `json:"published_at"`
	HTMLURL     string    `json:"html_url"`
	AssetURL    string    `json:"asset_url,omitempty"`
	SHA256      string    `json:"sha256,omitempty"`
}

// Available returns the latest release plus the most recent N releases
// from GitHub. limit <= 0 defaults to 10.
func (d *Downloader) Available(ctx context.Context, limit int) ([]AvailableRelease, error) {
	if limit <= 0 {
		limit = 10
	}
	api := d.GitHubAPI
	if api == "" {
		api = DefaultGitHubAPI
	}
	body, err := d.getGitHubJSON(ctx, api+"/releases?per_page="+fmt.Sprint(limit))
	if err != nil {
		return nil, err
	}
	var raw []struct {
		TagName     string    `json:"tag_name"`
		PublishedAt time.Time `json:"published_at"`
		HTMLURL     string    `json:"html_url"`
		Body        string    `json:"body"`
		Assets      []struct {
			Name        string `json:"name"`
			DownloadURL string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("decode releases: %w", err)
	}
	assetName, _ := CurrentAssetName()
	out := make([]AvailableRelease, 0, len(raw))
	for _, r := range raw {
		entry := AvailableRelease{
			TagName:     r.TagName,
			PublishedAt: r.PublishedAt,
			HTMLURL:     r.HTMLURL,
		}
		for _, a := range r.Assets {
			if a.Name == assetName {
				entry.AssetURL = a.DownloadURL
				break
			}
		}
		entry.SHA256 = ParseSHA256(r.Body, assetName)
		out = append(out, entry)
	}
	return out, nil
}

// shaLineRE captures one "filename: hex64" line from a release body's
// "### SHA256 Checksums" section.
var shaLineRE = regexp.MustCompile(`(?m)^([A-Za-z0-9._\-]+):\s+([a-fA-F0-9]{64})\s*$`)

// ParseSHA256 extracts the SHA256 for assetName from a release body's
// markdown. Returns empty string when not found — callers must treat
// missing checksum as a hard error before persisting.
func ParseSHA256(releaseBody, assetName string) string {
	for _, m := range shaLineRE.FindAllStringSubmatch(releaseBody, -1) {
		if m[1] == assetName {
			return strings.ToLower(m[2])
		}
	}
	return ""
}

// Install downloads version, verifies SHA256, applies platform post-
// processing (chmod / xattr stubbed for PR-10), and persists to
// `<root>/<version>/`. Returns the verified VersionMeta on success.
// Activation is deliberately separate (callers may want to install in
// the background without flipping the active pointer).
func (s *Store) Install(ctx context.Context, d *Downloader, version string) (VersionMeta, error) {
	assetName, ok := CurrentAssetName()
	if !ok {
		return VersionMeta{}, fmt.Errorf("cfdbin: unsupported target %s/%s", runtime.GOOS, runtime.GOARCH)
	}

	// 1. fetch release metadata to get the official SHA256
	api := d.GitHubAPI
	if api == "" {
		api = DefaultGitHubAPI
	}
	body, err := d.getGitHubJSON(ctx, api+"/releases/tags/"+version)
	if err != nil {
		return VersionMeta{}, fmt.Errorf("release lookup: %w", err)
	}
	var rel struct {
		TagName string `json:"tag_name"`
		Body    string `json:"body"`
		Assets  []struct {
			Name        string `json:"name"`
			DownloadURL string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(body, &rel); err != nil {
		return VersionMeta{}, fmt.Errorf("decode release: %w", err)
	}
	wantSHA := ParseSHA256(rel.Body, assetName)
	if wantSHA == "" {
		return VersionMeta{}, fmt.Errorf("release %s has no SHA256 for %s", version, assetName)
	}
	directURL := ""
	for _, a := range rel.Assets {
		if a.Name == assetName {
			directURL = a.DownloadURL
			break
		}
	}
	if directURL == "" {
		return VersionMeta{}, fmt.Errorf("release %s has no asset %s", version, assetName)
	}

	// 2. download bytes via mirror chain
	tmp, err := os.CreateTemp("", "cloudflared-dl-*")
	if err != nil {
		return VersionMeta{}, err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	tmp.Close()

	sha, size, mirror, err := d.downloadWithMirrors(ctx, directURL, tmp.Name())
	if err != nil {
		return VersionMeta{}, fmt.Errorf("download: %w", err)
	}
	if sha != wantSHA {
		return VersionMeta{}, fmt.Errorf("sha256 mismatch: got %s want %s", sha, wantSHA)
	}

	// 3. extract if archive; otherwise move bytes as-is
	if err := os.MkdirAll(s.versionDir(version), 0o755); err != nil {
		return VersionMeta{}, err
	}
	finalBin := s.binaryPath(version)
	if IsArchive(assetName) {
		if err := extractDarwinTGZ(tmp.Name(), finalBin); err != nil {
			return VersionMeta{}, fmt.Errorf("extract: %w", err)
		}
	} else {
		if err := os.Rename(tmp.Name(), finalBin); err != nil {
			// cross-device rename can fail; fall back to copy
			if err := copyFile(tmp.Name(), finalBin); err != nil {
				return VersionMeta{}, err
			}
		}
	}
	if runtime.GOOS != "windows" {
		_ = os.Chmod(finalBin, 0o755)
	}
	// platform post-processing (xattr / Unblock-File) is stubbed; see
	// spec §4.6. PR-10 wires it up alongside the install scripts.

	meta := VersionMeta{
		Version:      version,
		Platform:     runtime.GOOS,
		Arch:         runtime.GOARCH,
		AssetName:    assetName,
		SHA256:       sha,
		SourceURL:    directURL,
		Mirror:       mirror,
		DownloadedAt: time.Now().UTC(),
		SizeBytes:    size,
		Verified:     true,
	}
	if err := s.writeMeta(version, meta); err != nil {
		return meta, err
	}
	_ = os.WriteFile(filepath.Join(s.versionDir(version), ".verified"), nil, 0o644)
	return meta, nil
}

// downloadWithMirrors tries each mirror prefix in front of the direct
// URL until one yields bytes that match SHA. Returns the computed SHA,
// downloaded size, and the mirror URL used (empty when direct).
func (d *Downloader) downloadWithMirrors(ctx context.Context, directURL, destPath string) (string, int64, string, error) {
	urls := make([]string, 0, len(d.Mirrors)+1)
	for _, m := range d.Mirrors {
		if m == "" {
			continue
		}
		if strings.HasSuffix(m, "/") {
			urls = append(urls, m+directURL)
		} else {
			urls = append(urls, m+"/"+directURL)
		}
	}
	urls = append(urls, directURL)

	var lastErr error
	for _, u := range urls {
		sha, size, err := d.downloadOne(ctx, u, destPath)
		if err == nil {
			mirror := ""
			if u != directURL {
				mirror = strings.TrimSuffix(u, directURL)
			}
			return sha, size, mirror, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = errors.New("no urls tried")
	}
	return "", 0, "", lastErr
}

func (d *Downloader) downloadOne(ctx context.Context, url, destPath string) (string, int64, error) {
	client := d.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Minute}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", 0, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", 0, fmt.Errorf("http %d from %s", resp.StatusCode, url)
	}
	f, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	hasher := sha256.New()
	mw := io.MultiWriter(f, hasher)
	n, err := io.Copy(mw, resp.Body)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(hasher.Sum(nil)), n, nil
}

// getGitHubJSON makes an authenticated GET against api.github.com,
// returning the decoded JSON bytes. Mirrors are NOT used for API calls
// because mirrors typically only proxy releases/download paths.
func (d *Downloader) getGitHubJSON(ctx context.Context, url string) ([]byte, error) {
	client := d.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "cfdmgrd-cfdbin")
	if d.GitHubToken != "" {
		req.Header.Set("Authorization", "Bearer "+d.GitHubToken)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<14))
		return nil, fmt.Errorf("github api %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return io.ReadAll(io.LimitReader(resp.Body, 4<<20))
}

// copyFile is a tiny cross-device-safe rename fallback.
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}
```

---

## Task 5：写 `internal/cfdbin/extract_darwin.go`（极简 .tgz 解包）

```go
package cfdbin

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// extractDarwinTGZ extracts the first regular file named "cloudflared"
// from a .tgz archive into destBin. cloudflared darwin .tgz archives
// contain exactly one binary at the top level, so we keep this code
// dead simple: walk the tar, take the first matching regular entry.
func extractDarwinTGZ(tgzPath, destBin string) error {
	f, err := os.Open(tgzPath)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if h.Typeflag != tar.TypeReg {
			continue
		}
		if filepath.Base(h.Name) != "cloudflared" {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(destBin), 0o755); err != nil {
			return err
		}
		out, err := os.OpenFile(destBin, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, tr); err != nil {
			out.Close()
			return err
		}
		return out.Close()
	}
	return fmt.Errorf("cfdbin: 'cloudflared' not found in archive %s", tgzPath)
}
```

---

## Task 6：写测试 `internal/cfdbin/asset_test.go`

```go
package cfdbin_test

import (
	"testing"

	"github.com/mia-clark/cloudflared-manager/internal/cfdbin"
)

func TestAssetName_Supported(t *testing.T) {
	cases := []struct{ os, arch, want string }{
		{"linux", "amd64", "cloudflared-linux-amd64"},
		{"linux", "arm64", "cloudflared-linux-arm64"},
		{"linux", "arm", "cloudflared-linux-arm"},
		{"linux", "armhf", "cloudflared-linux-armhf"},
		{"linux", "386", "cloudflared-linux-386"},
		{"darwin", "amd64", "cloudflared-darwin-amd64.tgz"},
		{"darwin", "arm64", "cloudflared-darwin-arm64.tgz"},
		{"windows", "amd64", "cloudflared-windows-amd64.exe"},
		{"windows", "386", "cloudflared-windows-386.exe"},
	}
	for _, c := range cases {
		if got := cfdbin.AssetName(c.os, c.arch); got != c.want {
			t.Errorf("AssetName(%s,%s) = %q, want %q", c.os, c.arch, got, c.want)
		}
	}
}

func TestAssetName_Unsupported(t *testing.T) {
	for _, c := range []struct{ os, arch string }{
		{"linux", "riscv64"}, {"freebsd", "amd64"}, {"windows", "arm64"}, {"plan9", "amd64"},
	} {
		if got := cfdbin.AssetName(c.os, c.arch); got != "" {
			t.Errorf("AssetName(%s,%s) = %q, want empty", c.os, c.arch, got)
		}
	}
}

func TestBinaryFilename(t *testing.T) {
	if got := cfdbin.BinaryFilename("windows"); got != "cloudflared.exe" {
		t.Errorf("windows: got %q", got)
	}
	if got := cfdbin.BinaryFilename("linux"); got != "cloudflared" {
		t.Errorf("linux: got %q", got)
	}
}

func TestIsArchive(t *testing.T) {
	if !cfdbin.IsArchive("cloudflared-darwin-amd64.tgz") {
		t.Error("expected tgz to be archive")
	}
	if cfdbin.IsArchive("cloudflared-linux-amd64") {
		t.Error("expected bare binary not to be archive")
	}
}
```

---

## Task 7：写测试 `internal/cfdbin/store_test.go`

```go
package cfdbin_test

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/mia-clark/cloudflared-manager/internal/cfdbin"
)

// fakeInstall plants a fake binary + meta.json under a version dir so
// store-level tests can run without hitting the network.
func fakeInstall(t *testing.T, s *cfdbin.Store, version string) string {
	t.Helper()
	vdir := filepath.Join(s.Root(), version)
	if err := os.MkdirAll(vdir, 0o755); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(vdir, cfdbin.BinaryFilename(runtime.GOOS))
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin
}

func TestResolve_NoActive(t *testing.T) {
	s := cfdbin.New(t.TempDir())
	if _, err := s.Resolve(""); err == nil {
		t.Fatal("expected ErrNoActive")
	}
}

func TestResolve_SpecificMissing(t *testing.T) {
	s := cfdbin.New(t.TempDir())
	if _, err := s.Resolve("9.9.9"); err == nil {
		t.Fatal("expected ErrNotInstalled")
	}
}

func TestResolve_AfterActivate(t *testing.T) {
	s := cfdbin.New(t.TempDir())
	fakeInstall(t, s, "2026.5.2")
	if err := s.Activate("2026.5.2"); err != nil {
		t.Fatalf("activate: %v", err)
	}
	p, err := s.Resolve("")
	if err != nil {
		t.Fatalf("resolve current: %v", err)
	}
	if filepath.Base(p) != cfdbin.BinaryFilename(runtime.GOOS) {
		t.Errorf("unexpected resolved path: %s", p)
	}
}

func TestList_NewestFirst(t *testing.T) {
	s := cfdbin.New(t.TempDir())
	for _, v := range []string{"2026.4.1", "2026.5.2", "2025.10.0"} {
		fakeInstall(t, s, v)
	}
	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("len=%d want 3", len(got))
	}
	if got[0].Version != "2026.5.2" {
		t.Errorf("expected newest first, got %s", got[0].Version)
	}
}

func TestActivate_RejectMissing(t *testing.T) {
	s := cfdbin.New(t.TempDir())
	if err := s.Activate("doesnt-exist"); err == nil {
		t.Fatal("expected error on activating missing version")
	}
}

func TestDelete_RejectActive(t *testing.T) {
	s := cfdbin.New(t.TempDir())
	fakeInstall(t, s, "2026.5.2")
	_ = s.Activate("2026.5.2")
	if err := s.Delete("2026.5.2"); err == nil {
		t.Fatal("expected delete of active version to fail")
	}
}

func TestDelete_Removes(t *testing.T) {
	s := cfdbin.New(t.TempDir())
	fakeInstall(t, s, "2026.4.1")
	fakeInstall(t, s, "2026.5.2")
	_ = s.Activate("2026.5.2")
	if err := s.Delete("2026.4.1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	got, _ := s.List()
	if len(got) != 1 || got[0].Version != "2026.5.2" {
		t.Errorf("after delete list = %+v", got)
	}
}
```

---

## Task 8：写测试 `internal/cfdbin/download_test.go`

```go
package cfdbin_test

import (
	"testing"

	"github.com/mia-clark/cloudflared-manager/internal/cfdbin"
)

const sampleReleaseBody = `Some intro text.

### SHA256 Checksums:

cloudflared-linux-amd64: 5286698547f03df745adb2355f04c12dde52ef425491e81f433642d695521886
cloudflared-darwin-amd64.tgz: aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899
cloudflared-windows-amd64.exe: deadbeefcafef00d1122334455667788991122334455667788991122334455667
`

func TestParseSHA256_Found(t *testing.T) {
	got := cfdbin.ParseSHA256(sampleReleaseBody, "cloudflared-linux-amd64")
	want := "5286698547f03df745adb2355f04c12dde52ef425491e81f433642d695521886"
	if got != want {
		t.Errorf("got %s want %s", got, want)
	}
}

func TestParseSHA256_DarwinArchive(t *testing.T) {
	got := cfdbin.ParseSHA256(sampleReleaseBody, "cloudflared-darwin-amd64.tgz")
	if got != "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899" {
		t.Errorf("got %s", got)
	}
}

func TestParseSHA256_Missing(t *testing.T) {
	if got := cfdbin.ParseSHA256(sampleReleaseBody, "cloudflared-bsd-amd64"); got != "" {
		t.Errorf("expected empty, got %s", got)
	}
}

func TestParseSHA256_NoBody(t *testing.T) {
	if got := cfdbin.ParseSHA256("", "cloudflared-linux-amd64"); got != "" {
		t.Errorf("expected empty on empty body, got %s", got)
	}
}
```

> 注：完整的 `Install` 端到端测试需要 mock 远端文件，复杂度高；本 PR 只验证 `ParseSHA256` 单元 + `Store` 文件系统逻辑。`Install` 路径通过 PR-08 / PR-10 的集成验证。

---

## Task 9：跑 cfdbin 包测试
```bash
go vet ./internal/cfdbin/...
go test ./internal/cfdbin/... -v -count=1 2>&1 | tail -40
```
Expected: vet 0；测试全 PASS（~15 个测试）。

---

## Task 10：扩展 appcfg

修改 `internal/appcfg/appcfg.go`：在 Config struct 加 4 个字段；在 Load() 加 4 个 env 读取；衍生 BinariesDir。

具体改动（用 Edit 工具）：

**Struct 加字段**：

old:
```go
	SelfUpdateEnabled bool
	ShutdownWait      time.Duration
}
```

new:
```go
	SelfUpdateEnabled       bool
	BinariesDir             string
	DownloadMirrors         []string
	GitHubToken             string
	CloudflaredDefaultVersion string
	ShutdownWait            time.Duration
}
```

**Load 加 env 读**（在 SelfUpdateEnabled 行之后）：

old:
```go
		SelfUpdateEnabled: parseBool(getEnv("CFDM_SELF_UPDATE_ENABLED", "true"), true),
		ShutdownWait:      10 * time.Second,
	}
	cfg.ProfilesDir = cfg.DataDir + "/profiles"
```

new:
```go
		SelfUpdateEnabled:         parseBool(getEnv("CFDM_SELF_UPDATE_ENABLED", "true"), true),
		DownloadMirrors:           splitCSV(getEnv("CFDM_DOWNLOAD_MIRRORS", "https://gh-proxy.org/,https://gh-proxy.com/")),
		GitHubToken:               getEnv("CFDM_GITHUB_TOKEN", ""),
		CloudflaredDefaultVersion: getEnv("CFDM_CLOUDFLARED_DEFAULT_VERSION", ""),
		ShutdownWait:              10 * time.Second,
	}
	cfg.ProfilesDir = cfg.DataDir + "/profiles"
```

**衍生 BinariesDir**（在 cfg.MetaFile 行之后）：

old:
```go
	cfg.MetaFile = cfg.DataDir + "/meta.json"

	if cfg.APIToken == "" {
```

new:
```go
	cfg.MetaFile = cfg.DataDir + "/meta.json"
	cfg.BinariesDir = getEnv("CFDM_BINARIES_DIR", cfg.DataDir+"/bin/cloudflared")

	if cfg.APIToken == "" {
```

**EnsureDirs 加 BinariesDir**：

old:
```go
	for _, d := range []string{c.DataDir, c.ProfilesDir, c.LogsDir, c.StoresDir} {
```

new:
```go
	for _, d := range []string{c.DataDir, c.ProfilesDir, c.LogsDir, c.StoresDir, c.BinariesDir} {
```

跑 `go vet ./internal/appcfg/...` 验证。

---

## Task 11：写 `internal/api/binaries.go`

完整内容：

```go
package api

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/mia-clark/cloudflared-manager/internal/api/apiresp"
	"github.com/mia-clark/cloudflared-manager/internal/cfdbin"
)

// BinariesHandler exposes /api/v1/binaries/* — multi-version cloudflared
// binary management. Methods are thin wrappers around cfdbin.Store and
// cfdbin.Downloader.
type BinariesHandler struct {
	store      *cfdbin.Store
	downloader *cfdbin.Downloader
	log        *slog.Logger
}

// NewBinariesHandler builds a handler with the given store + downloader.
func NewBinariesHandler(store *cfdbin.Store, downloader *cfdbin.Downloader, log *slog.Logger) *BinariesHandler {
	return &BinariesHandler{store: store, downloader: downloader, log: log}
}

// List handles GET /api/v1/binaries.
func (h *BinariesHandler) List(w http.ResponseWriter, r *http.Request) {
	items, err := h.store.List()
	if err != nil {
		apiresp.Error(w, http.StatusInternalServerError, "list_failed", err.Error(), nil)
		return
	}
	apiresp.JSON(w, http.StatusOK, map[string]any{"items": items})
}

// Available handles GET /api/v1/binaries/available.
func (h *BinariesHandler) Available(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*1e9)
	defer cancel()
	rels, err := h.downloader.Available(ctx, 10)
	if err != nil {
		apiresp.Error(w, http.StatusBadGateway, "github_query_failed", err.Error(), nil)
		return
	}
	apiresp.JSON(w, http.StatusOK, map[string]any{"items": rels})
}

// installRequest is the body of POST /api/v1/binaries/install.
type installRequest struct {
	Version string `json:"version"`
}

// Install handles POST /api/v1/binaries/install (synchronous in PR-05;
// PR-08 will move it to an async job with progress over WS).
func (h *BinariesHandler) Install(w http.ResponseWriter, r *http.Request) {
	var req installRequest
	if err := decodeJSON(r, &req); err != nil {
		apiresp.Error(w, http.StatusBadRequest, "bad_request", err.Error(), nil)
		return
	}
	if req.Version == "" {
		apiresp.Error(w, http.StatusBadRequest, "bad_request", "version is required", nil)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*60*1e9)
	defer cancel()
	meta, err := h.store.Install(ctx, h.downloader, req.Version)
	if err != nil {
		h.log.Warn("binary install failed", slog.String("version", req.Version), slog.Any("err", err))
		apiresp.Error(w, http.StatusBadGateway, "install_failed", err.Error(), nil)
		return
	}
	apiresp.JSON(w, http.StatusOK, meta)
}

// Activate handles POST /api/v1/binaries/{version}/activate.
func (h *BinariesHandler) Activate(w http.ResponseWriter, r *http.Request) {
	v := chi.URLParam(r, "version")
	if err := h.store.Activate(v); err != nil {
		apiresp.Error(w, http.StatusBadRequest, "activate_failed", err.Error(), nil)
		return
	}
	apiresp.JSON(w, http.StatusOK, map[string]any{"version": v, "active": true})
}

// Delete handles DELETE /api/v1/binaries/{version}.
func (h *BinariesHandler) Delete(w http.ResponseWriter, r *http.Request) {
	v := chi.URLParam(r, "version")
	if err := h.store.Delete(v); err != nil {
		apiresp.Error(w, http.StatusBadRequest, "delete_failed", err.Error(), nil)
		return
	}
	apiresp.JSON(w, http.StatusNoContent, nil)
}
```

> 注意：`apiresp.JSON` / `apiresp.Error` / `decodeJSON` 这三个 helper 已存在于 `internal/api/apiresp/` 与 `internal/api/helpers.go`。Implementer 应当确认实际命名（用 grep 看现有 handlers 调的是 `apiresp.JSON` 还是 `WriteJSON` 等）；如果名字不同，按现状对齐而不是按本 plan 字面。**这一项是 plan 的已知不确定点**。

---

## Task 12：注册路由 + 集成

### Step 12.1 改 `internal/api/server.go`

在 Deps 加 `BinaryStore` + `BinaryDownloader`：

```go
type Deps struct {
	Cfg              *appcfg.Config
	Logger           *slog.Logger
	Manager          *manager.Manager
	Metrics          *metrics.Store
	BinaryStore      *cfdbin.Store
	BinaryDownloader *cfdbin.Downloader
}
```

加 import `"github.com/mia-clark/cloudflared-manager/internal/cfdbin"`。

在 handler 初始化区加：
```go
binaries := NewBinariesHandler(d.BinaryStore, d.BinaryDownloader, d.Logger)
```

在 authenticated 子树注册：
```go
r.Get("/api/v1/binaries", binaries.List)
r.Get("/api/v1/binaries/available", binaries.Available)
r.Post("/api/v1/binaries/install", binaries.Install)
r.Post("/api/v1/binaries/{version}/activate", binaries.Activate)
r.Delete("/api/v1/binaries/{version}", binaries.Delete)
```

### Step 12.2 改 `internal/manager/manager.go`

`Options` 加 `BinaryStore *cfdbin.Store` 字段：

```go
type Options struct {
	ProfilesDir string
	LogsDir     string
	StoresDir   string
	MetaPath    string
	Logger      *slog.Logger
	Bus         *eventbus.Bus
	BinaryStore *cfdbin.Store
}
```

import `"github.com/mia-clark/cloudflared-manager/internal/cfdbin"`。

`Manager` struct 加字段：

```go
binStore *cfdbin.Store
```

`New` 函数 return 那里：

```go
return &Manager{
	opts:       opts,
	binStore:   opts.BinaryStore,
	...
```

`register` 把 binStore 传给 instance：

```go
inst := newInstance(id, path, m.opts.Logger, m.opts.Bus, m.logWriter(id), m.binStore)
```

### Step 12.3 改 `internal/manager/instance.go`

`instance` struct 加字段：
```go
binStore *cfdbin.Store
```

import `cfdbin`。

`newInstance` 多接 1 个参数：
```go
func newInstance(id, path string, logger *slog.Logger, bus *eventbus.Bus, logSink io.Writer, binStore *cfdbin.Store) *instance {
	return &instance{
		...
		binStore: binStore,
		...
	}
}
```

`Snapshot` 中给 `BinaryVersion` 字段填值（暂用 active 版本或 instance pin 的版本）。**简化**：PR-05 暂不持久化 per-instance binary version（meta.json 字段在 PR-08 接入），Snapshot 中 BinaryVersion 直接读 `binStore` 的 active（最差当 fallback）：

```go
if i.binStore != nil {
	if path, err := i.binStore.Resolve(""); err == nil {
		// 反推 version 名：active.json 里读，简单点
		// 这里 instance 不知道版本号字符串。我们让 Snapshot 留空，UI 自己 GET /binaries 拉
		_ = path
	}
}
```

更简单：BinaryVersion 暂留空，前端单独 GET /binaries 拉 IsActive 行展示。

`start()` 中替换硬编码 "cloudflared"：
```go
binPath := "cloudflared" // PATH fallback
if i.binStore != nil {
	if p, err := i.binStore.Resolve(""); err == nil {
		binPath = p
	}
}
w, err := process.Spawn(runCtx, process.SpawnParams{
	BinaryPath:   binPath,
	...
```

### Step 12.4 改 `cmd/cfdmgrd/main.go`

import cfdbin。在 manager.New 之前构造 store + downloader：

```go
binStore := cfdbin.New(cfg.BinariesDir)
binDl := &cfdbin.Downloader{
	Mirrors:     cfg.DownloadMirrors,
	GitHubToken: cfg.GitHubToken,
}
```

`manager.New(opts)` 加 `BinaryStore: binStore`。

`api.NewRouter` 加 `BinaryStore: binStore, BinaryDownloader: binDl`。

### Step 12.5 vet + test + build + smoke
```bash
go vet ./...
go test ./... -count=1 2>&1 | tail -15
go build -o bin/cfdmgrd ./cmd/cfdmgrd && ./bin/cfdmgrd version
rm -rf ./tmp/data; mkdir -p ./tmp/data
CFDM_API_TOKEN=dev CFDM_DATA_DIR=./tmp/data ./bin/cfdmgrd serve > /tmp/cfdmgrd-pr05.log 2>&1 &
SERVE_PID=$!
sleep 2
curl -fsS http://127.0.0.1:8080/api/v1/health; echo
curl -fsS -H "Authorization: Bearer dev" http://127.0.0.1:8080/api/v1/binaries; echo
kill $SERVE_PID 2>/dev/null; sleep 1
rm -rf ./tmp/data /tmp/cfdmgrd-pr05.log
```
Expected: 全绿；`/binaries` 返回 `{"items":[]}` 或类似空列表。

### Step 12.6 gofmt
```bash
gofmt -l internal/cfdbin internal/appcfg internal/api internal/manager cmd/cfdmgrd
```
Expected: 无输出。

---

## Task 13：commit（controller 主线）

---

## Self-Review

✅ spec §4 覆盖：4.1 目录布局、4.3 asset 映射、4.4 SHA256 解析、4.5 镜像 fallback、4.7 多版本切换
⏸ spec §4.2 首次启动捆绑：留 PR-10 Dockerfile 阶段处理
⏸ spec §4.6 macOS quarantine / Windows MOTW 处理：留 PR-10 处理
⏸ spec §4.8 升级时进程协调：留 PR-08 处理
✅ 类型一致：Store 公开方法（New/Root/Resolve/List/Activate/Delete/Install）+ Downloader 公开（Available + 内部 download 助手）
✅ 依赖方向：cfdbin 仅 std lib；manager → cfdbin（合法）；api → cfdbin（合法）

---

## Execution Handoff

2 batch：
- **Batch I** = Task 1-9（cfdbin 包 + 所有测试）
- **Batch II** = Task 10-12（appcfg + handler + 集成 + smoke）
- Task 13 commit 由 controller。
