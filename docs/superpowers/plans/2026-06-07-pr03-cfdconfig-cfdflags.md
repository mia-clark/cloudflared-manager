# PR-03 新增 pkg/cfdconfig + pkg/cfdflags 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** 新增两个**纯叶子包**，为后续 PR-04 / PR-07 / PR-08 准备数据模型与元数据弹药：

1. `pkg/cfdconfig`：`TunnelConfigV1` 数据结构 + YAML/JSON 双向编解码 + 基础字段校验
2. `pkg/cfdflags`：cloudflared CLI flag 元数据 + flag↔env↔YAML 三向映射 + UI 表单 schema + env 白名单 + 12 条告警规则模板

完成后：两个新包跑 `go vet` + `go test` 全绿；TunnelConfigV1 能往返 YAML/JSON；cfdflags 能枚举所有暴露 flag 并给出对应 env 名。**不修改任何现有文件**（包括 manager / api / pkg/config 等都不动），这是单纯的"新增弹药 PR"。

**Architecture:** 两个包都是叶子包，**无相互依赖**。
- `cfdconfig` 只负责数据建模 + 编解码 + 语法/枚举级校验
- `cfdflags` 只负责元数据表 + 映射表 + 告警模板常量
- 业务级联合校验（如 protocol=http2 时禁 post_quantum）将由 `internal/api/validate.go` 在 PR-08 时联合调用两包完成

**Tech Stack:**
- 新增依赖：`gopkg.in/yaml.v3`（已在 spec §10.4 列出新增）
- 沿用：std `encoding/json`、`time`
- 测试：std `testing` + 手写 fixture

---

## 文件结构总览

| 路径 | 动作 | 说明 |
|---|---|---|
| `pkg/cfdconfig/tunnel.go` | **Create** | `TunnelConfigV1` struct + Edge/Reliability/Logging/Identity 子结构 |
| `pkg/cfdconfig/codec.go` | **Create** | `ParseYAML([]byte) (*TunnelConfigV1, error)` + `MarshalYAML(*TunnelConfigV1) ([]byte, error)` + `ParseJSON` + `MarshalJSON` |
| `pkg/cfdconfig/validate.go` | **Create** | `(*TunnelConfigV1).Validate() error` — 语法 + 枚举 + 范围校验（不做跨字段业务约束） |
| `pkg/cfdconfig/tunnel_test.go` | **Create** | YAML/JSON 往返测试 + 字段默认值 + omitempty |
| `pkg/cfdconfig/validate_test.go` | **Create** | 12+ 边界测试 |
| `pkg/cfdflags/flags.go` | **Create** | `Flag` 结构 + 公开 `Flags()` 返回所有可见 flag 元数据；`Group` 枚举 |
| `pkg/cfdflags/mapping.go` | **Create** | `ToTunnelEnv(*cfdconfig.TunnelConfigV1) map[string]string` — YAML 转 cloudflared 子进程 env；**但本 PR 不引入 cfdconfig 依赖，签名改为 ToTunnelEnv(opts Options) map[string]string** |
| `pkg/cfdflags/whitelist.go` | **Create** | `AllowEnvOverride(envName) bool` — 用户自定义高级覆盖白名单 |
| `pkg/cfdflags/alerts.go` | **Create** | 12 条 `AlertRuleTemplate` 常量（spec §5.4） |
| `pkg/cfdflags/flags_test.go` | **Create** | 元数据完整性 + 映射对称性测试 |
| `pkg/cfdflags/whitelist_test.go` | **Create** | 白名单 boundary 测试 |
| `go.mod` | **Modify** | 新增 `gopkg.in/yaml.v3 vX.X.X`（require 块） |
| `go.sum` | **Modify** | 由 `go mod tidy` 自动 |

> 关于 `mapping.go` 的依赖方向：为避免 `cfdflags → cfdconfig` 反向依赖（cfdflags 是元数据应当独立），`ToTunnelEnv` 接受一个本包定义的轻量 `Options` 结构（与 TunnelConfigV1 同构但解耦），由 PR-04 的 `internal/process` 层做"TunnelConfigV1 → Options"映射调用。

---

## Task 1：基线 + 加 yaml.v3 依赖

- [ ] **Step 1.1 git status 干净**

```bash
cd /d/Github_Codes_mia-clark/cloudflared-manager
git status
```

Expected: branch `feature/pr01-bootstrap-rename`，working tree clean。

- [ ] **Step 1.2 基线 vet+test+build 全绿**

```bash
go vet ./... && go test ./... && go build -o /tmp/baseline ./cmd/cfdmgrd && rm -f /tmp/baseline
```

Expected: 全绿。

- [ ] **Step 1.3 加 yaml.v3 依赖**

```bash
go get gopkg.in/yaml.v3@v3.0.1
go mod tidy
grep -n 'yaml.v3' go.mod
```

Expected stdout: 含 `gopkg.in/yaml.v3 v3.0.1`。

> 注：yaml.v2 已是 frp 间接依赖（PR-11 清理）；v3 是新引入直接依赖。

- [ ] **Step 1.4 vet 仍然 ok**

```bash
go vet ./...
```

Expected: exit 0。

---

## Task 2：创建 pkg/cfdconfig

**Files:**
- Create: `pkg/cfdconfig/tunnel.go`
- Create: `pkg/cfdconfig/codec.go`
- Create: `pkg/cfdconfig/validate.go`

- [ ] **Step 2.1 mkdir + 写 `pkg/cfdconfig/tunnel.go`**

```bash
mkdir -p pkg/cfdconfig
```

内容：

```go
// Package cfdconfig defines the local-side configuration model for a
// single cloudflared instance managed by cfdmgrd.
//
// The model deliberately covers ONLY the parameters the connector
// process consumes when invoked as `cloudflared tunnel run --token ...`.
// All ingress / public-hostname / origin-side settings live in the
// Cloudflare Zero Trust dashboard and are NOT modelled here.
//
// YAML is the on-disk format (one .yaml file per instance under
// $DATA_DIR/profiles/). JSON is used over the HTTP API. Both encodings
// share the same tag set (camelCase) so a config round-trips through
// either without re-shaping.
package cfdconfig

// TunnelConfigV1 is the v1 schema. Major shape changes should bump to a
// new struct (TunnelConfigV2) and migrate, never silently widen this one.
type TunnelConfigV1 struct {
	// Token is the cloudflared connector token. Highly sensitive.
	// API responses that include the full Config envelope MUST strip
	// this field by default; see internal/api/configs.go for the read
	// path. The dedicated GET /configs/{id}/token endpoint serves a
	// masked form.
	Token string `yaml:"token,omitempty" json:"token,omitempty"`

	Edge        EdgeConfig        `yaml:"edge,omitempty" json:"edge,omitempty"`
	Reliability ReliabilityConfig `yaml:"reliability,omitempty" json:"reliability,omitempty"`
	Logging     LoggingConfig     `yaml:"logging,omitempty" json:"logging,omitempty"`
	Identity    IdentityConfig    `yaml:"identity,omitempty" json:"identity,omitempty"`

	// AdvancedEnvOverrides is the user escape hatch for cloudflared env
	// vars not modelled above. Values are merged into the child process
	// env at spawn time AFTER the cfdmgrd-mandated env (TUNNEL_TOKEN /
	// NO_AUTOUPDATE / TUNNEL_METRICS / TUNNEL_OUTPUT), so user overrides
	// CANNOT clobber those. The list of permitted keys is enforced by
	// pkg/cfdflags.AllowEnvOverride.
	AdvancedEnvOverrides map[string]string `yaml:"advancedEnvOverrides,omitempty" json:"advancedEnvOverrides,omitempty"`

	// BinaryVersion pins the cloudflared binary version used by this
	// instance. Empty / "current" = follow the global active version.
	// A concrete tag (e.g. "2026.5.2") pins independently for canary or
	// rollback purposes. The pkg/cfdbin package (added in PR-05) is
	// responsible for resolving this to a real path.
	BinaryVersion string `yaml:"binaryVersion,omitempty" json:"binaryVersion,omitempty"`
}

// EdgeConfig groups parameters that influence how cloudflared reaches
// the Cloudflare edge network.
type EdgeConfig struct {
	// Protocol selects the transport between cloudflared and the edge.
	// "auto" (default) prefers QUIC and falls back to HTTP/2; "quic"
	// and "http2" force the choice. Anything else is rejected by
	// Validate.
	Protocol string `yaml:"protocol,omitempty" json:"protocol,omitempty"`

	// EdgeIPVersion picks the IP family used to dial the edge.
	// "auto" defers to the OS; "4" / "6" forces. Default empty == "4"
	// upstream.
	EdgeIPVersion string `yaml:"edgeIpVersion,omitempty" json:"edgeIpVersion,omitempty"`

	// EdgeBindAddress optionally pins the local source IP for outbound
	// edge connections. Its IP family overrides EdgeIPVersion when set.
	EdgeBindAddress string `yaml:"edgeBindAddress,omitempty" json:"edgeBindAddress,omitempty"`

	// Region restricts the edge routing region. Currently the only
	// non-empty value cloudflared accepts is "us". Empty means global.
	Region string `yaml:"region,omitempty" json:"region,omitempty"`

	// PostQuantum forces a post-quantum key exchange with the edge.
	// Only effective when Protocol == "quic"; Validate rejects it with
	// any other protocol because cloudflared itself errors out at boot.
	PostQuantum bool `yaml:"postQuantum,omitempty" json:"postQuantum,omitempty"`
}

// ReliabilityConfig groups retry / shutdown behavior.
type ReliabilityConfig struct {
	// Retries is the maximum number of connection / protocol retries
	// before giving up. cloudflared defaults to 5 with exponential
	// backoff (1s, 2s, 4s, 8s, 16s). Validate accepts 1..20; the
	// upstream is unbounded but values above 20 indicate misuse.
	Retries int `yaml:"retries,omitempty" json:"retries,omitempty"`

	// GracePeriod is the duration cloudflared waits for in-flight
	// requests to finish after receiving SIGINT/SIGTERM before exiting.
	// A second matching signal short-circuits the wait. Values are
	// parsed as Go time.Duration strings ("30s", "2m", etc.). Default
	// upstream is 30s.
	GracePeriod string `yaml:"gracePeriod,omitempty" json:"gracePeriod,omitempty"`
}

// LoggingConfig controls cloudflared's two log levels. The destination
// stream and format (JSON via --output) are decided by cfdmgrd itself
// and NOT modelled here on purpose: ProcessTailer relies on stderr +
// JSON for structured parsing.
type LoggingConfig struct {
	// LogLevel controls application-level events (default "info").
	// Accepted: debug, info, warn, error, fatal.
	LogLevel string `yaml:"logLevel,omitempty" json:"logLevel,omitempty"`

	// TransportLogLevel controls QUIC/HTTP2 transport events
	// separately. Same vocabulary as LogLevel.
	TransportLogLevel string `yaml:"transportLogLevel,omitempty" json:"transportLogLevel,omitempty"`
}

// IdentityConfig holds connector-identity hints reported back to the
// Cloudflare Zero Trust dashboard.
type IdentityConfig struct {
	// Label is the connector display name. Limited to a small charset
	// by Validate. Note: cloudflared has no TUNNEL_LABEL env var, so
	// this is the ONE field cfdmgrd passes through argv at spawn time.
	Label string `yaml:"label,omitempty" json:"label,omitempty"`

	// Tags is a free-form key→value annotation set that propagates to
	// the dashboard. cloudflared accepts these via TUNNEL_TAG as a
	// comma-joined "k1=v1,k2=v2" string.
	Tags map[string]string `yaml:"tags,omitempty" json:"tags,omitempty"`
}
```

- [ ] **Step 2.2 写 `pkg/cfdconfig/codec.go`**

内容：

```go
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
```

- [ ] **Step 2.3 写 `pkg/cfdconfig/validate.go`**

内容：

```go
package cfdconfig

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// Validate runs syntactic and enumeration checks on a TunnelConfigV1.
// It deliberately does NOT cross-validate against pkg/cfdflags business
// rules (e.g. "postQuantum requires protocol == quic") — that lives in
// the API validate layer where both packages are available.
//
// A nil receiver returns ErrNilConfig; callers should treat that as
// "fresh / empty draft" rather than a hard error.
func (c *TunnelConfigV1) Validate() error {
	if c == nil {
		return ErrNilConfig
	}
	if err := validateToken(c.Token); err != nil {
		return fmt.Errorf("token: %w", err)
	}
	if err := c.Edge.validate(); err != nil {
		return fmt.Errorf("edge: %w", err)
	}
	if err := c.Reliability.validate(); err != nil {
		return fmt.Errorf("reliability: %w", err)
	}
	if err := c.Logging.validate(); err != nil {
		return fmt.Errorf("logging: %w", err)
	}
	if err := c.Identity.validate(); err != nil {
		return fmt.Errorf("identity: %w", err)
	}
	if err := validateAdvancedEnv(c.AdvancedEnvOverrides); err != nil {
		return fmt.Errorf("advancedEnvOverrides: %w", err)
	}
	return nil
}

// ErrNilConfig is returned by Validate on a nil receiver.
var ErrNilConfig = errors.New("cfdconfig: nil config")

// ---- token ----

// tokenRE matches a base64url-ish string with no padding (cloudflared
// tokens are base64-encoded JSON; the inner JSON is opaque to us here).
var tokenRE = regexp.MustCompile(`^[A-Za-z0-9_\-+/=]+$`)

func validateToken(t string) error {
	if t == "" {
		return nil // empty token = "not yet provisioned"; allowed in drafts
	}
	if n := len(t); n < 100 || n > 1500 {
		return fmt.Errorf("length %d outside [100, 1500]", n)
	}
	if !tokenRE.MatchString(t) {
		return errors.New("contains non-base64 characters")
	}
	return nil
}

// ---- edge ----

var validProtocols = map[string]bool{"": true, "auto": true, "http2": true, "quic": true}
var validEdgeIPVersions = map[string]bool{"": true, "auto": true, "4": true, "6": true}
var validRegions = map[string]bool{"": true, "us": true}

func (e EdgeConfig) validate() error {
	if !validProtocols[e.Protocol] {
		return fmt.Errorf("protocol %q not in {auto,http2,quic}", e.Protocol)
	}
	if !validEdgeIPVersions[e.EdgeIPVersion] {
		return fmt.Errorf("edgeIpVersion %q not in {auto,4,6}", e.EdgeIPVersion)
	}
	if !validRegions[e.Region] {
		return fmt.Errorf("region %q not in {\"\",us}", e.Region)
	}
	// EdgeBindAddress: best-effort syntactic check; cloudflared itself
	// rejects malformed values at start, so we only filter obvious junk.
	if a := strings.TrimSpace(e.EdgeBindAddress); a != "" {
		if strings.ContainsAny(a, " \t\n\r") {
			return fmt.Errorf("edgeBindAddress contains whitespace: %q", e.EdgeBindAddress)
		}
	}
	return nil
}

// ---- reliability ----

func (r ReliabilityConfig) validate() error {
	if r.Retries < 0 || r.Retries > 20 {
		return fmt.Errorf("retries %d outside [0, 20]", r.Retries)
	}
	if gp := strings.TrimSpace(r.GracePeriod); gp != "" {
		d, err := time.ParseDuration(gp)
		if err != nil {
			return fmt.Errorf("gracePeriod %q not a duration: %w", gp, err)
		}
		if d < time.Second || d > 5*time.Minute {
			return fmt.Errorf("gracePeriod %s outside [1s, 5m]", d)
		}
	}
	return nil
}

// ---- logging ----

var validLogLevels = map[string]bool{
	"":      true,
	"debug": true, "info": true, "warn": true, "error": true, "fatal": true,
}

func (l LoggingConfig) validate() error {
	if !validLogLevels[strings.ToLower(l.LogLevel)] {
		return fmt.Errorf("logLevel %q not in {debug,info,warn,error,fatal}", l.LogLevel)
	}
	if !validLogLevels[strings.ToLower(l.TransportLogLevel)] {
		return fmt.Errorf("transportLogLevel %q not in {debug,info,warn,error,fatal}", l.TransportLogLevel)
	}
	return nil
}

// ---- identity ----

var labelRE = regexp.MustCompile(`^[A-Za-z0-9_\-\. ]+$`)
var tagKeyRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func (i IdentityConfig) validate() error {
	if l := i.Label; l != "" {
		if len(l) > 64 {
			return fmt.Errorf("label length %d > 64", len(l))
		}
		if !labelRE.MatchString(l) {
			return fmt.Errorf("label %q contains illegal characters", l)
		}
	}
	for k, v := range i.Tags {
		if k == "" || len(k) > 32 {
			return fmt.Errorf("tag key %q length out of [1,32]", k)
		}
		if !tagKeyRE.MatchString(k) {
			return fmt.Errorf("tag key %q does not match [A-Za-z_][A-Za-z0-9_]*", k)
		}
		if len(v) > 128 {
			return fmt.Errorf("tag %s value length %d > 128", k, len(v))
		}
	}
	return nil
}

// ---- advanced env overrides ----

// reservedEnv is the subset of TUNNEL_* / NO_AUTOUPDATE keys cfdmgrd
// itself injects at spawn time and which users MUST NOT override via
// AdvancedEnvOverrides — overriding would either nuke the token, allow
// cloudflared to self-update behind cfdmgrd's back, or hide metrics
// behind a port we can't scrape.
var reservedEnv = map[string]bool{
	"TUNNEL_TOKEN":      true,
	"NO_AUTOUPDATE":     true,
	"AUTOUPDATE_FREQ":   true,
	"TUNNEL_METRICS":    true,
	"TUNNEL_OUTPUT":     true,
	"TUNNEL_LOGFILE":    true,
	"TUNNEL_LOGDIRECTORY": true,
}

var envKeyRE = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)

func validateAdvancedEnv(env map[string]string) error {
	for k := range env {
		if !envKeyRE.MatchString(k) {
			return fmt.Errorf("env key %q must match ^[A-Z][A-Z0-9_]*$", k)
		}
		if reservedEnv[k] {
			return fmt.Errorf("env key %q is reserved by cfdmgrd", k)
		}
	}
	return nil
}
```

- [ ] **Step 2.4 单包 vet**

```bash
go vet ./pkg/cfdconfig/...
```

Expected: exit 0。

---

## Task 3：写 cfdconfig 测试

**Files:**
- Create: `pkg/cfdconfig/tunnel_test.go`
- Create: `pkg/cfdconfig/validate_test.go`

- [ ] **Step 3.1 写 `pkg/cfdconfig/tunnel_test.go`**（YAML/JSON 往返）

```go
package cfdconfig_test

import (
	"strings"
	"testing"

	"github.com/mia-clark/cloudflared-manager/pkg/cfdconfig"
)

const sampleYAML = `token: eyJhIjoiMjk
binaryVersion: "current"
edge:
  protocol: auto
  edgeIpVersion: "4"
  postQuantum: false
reliability:
  retries: 5
  gracePeriod: 30s
logging:
  logLevel: info
  transportLogLevel: info
identity:
  label: home-nas
  tags:
    env: prod
    site: shanghai
`

func TestParseYAML_Sample(t *testing.T) {
	cfg, err := cfdconfig.ParseYAML([]byte(sampleYAML))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if cfg.Token != "eyJhIjoiMjk" {
		t.Errorf("token=%q", cfg.Token)
	}
	if cfg.BinaryVersion != "current" {
		t.Errorf("binaryVersion=%q", cfg.BinaryVersion)
	}
	if cfg.Edge.Protocol != "auto" {
		t.Errorf("edge.protocol=%q", cfg.Edge.Protocol)
	}
	if cfg.Edge.EdgeIPVersion != "4" {
		t.Errorf("edge.edgeIpVersion=%q", cfg.Edge.EdgeIPVersion)
	}
	if cfg.Reliability.Retries != 5 {
		t.Errorf("reliability.retries=%d", cfg.Reliability.Retries)
	}
	if cfg.Reliability.GracePeriod != "30s" {
		t.Errorf("reliability.gracePeriod=%q", cfg.Reliability.GracePeriod)
	}
	if cfg.Identity.Label != "home-nas" {
		t.Errorf("identity.label=%q", cfg.Identity.Label)
	}
	if cfg.Identity.Tags["env"] != "prod" {
		t.Errorf("identity.tags[env]=%q", cfg.Identity.Tags["env"])
	}
}

func TestParseYAML_Empty(t *testing.T) {
	cfg, err := cfdconfig.ParseYAML([]byte(""))
	if err != nil {
		t.Fatalf("parse empty: %v", err)
	}
	if cfg == nil {
		t.Fatal("expected zero-value struct, got nil")
	}
}

func TestParseYAML_Whitespace(t *testing.T) {
	cfg, err := cfdconfig.ParseYAML([]byte("   \n  \n"))
	if err != nil {
		t.Fatalf("parse whitespace: %v", err)
	}
	if cfg == nil {
		t.Fatal("expected zero-value struct, got nil")
	}
}

func TestParseYAML_Malformed(t *testing.T) {
	_, err := cfdconfig.ParseYAML([]byte("token: [unclosed"))
	if err == nil {
		t.Fatal("expected parse error on malformed yaml")
	}
}

func TestMarshalYAML_RoundTrip(t *testing.T) {
	orig, err := cfdconfig.ParseYAML([]byte(sampleYAML))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	out, err := cfdconfig.MarshalYAML(orig)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if len(out) == 0 {
		t.Fatal("marshal returned empty")
	}
	again, err := cfdconfig.ParseYAML(out)
	if err != nil {
		t.Fatalf("re-parse: %v", err)
	}
	if again.Token != orig.Token ||
		again.Edge.Protocol != orig.Edge.Protocol ||
		again.Reliability.Retries != orig.Reliability.Retries ||
		again.Identity.Tags["env"] != orig.Identity.Tags["env"] {
		t.Errorf("round trip diff: %+v vs %+v", orig, again)
	}
}

func TestMarshalYAML_OmitEmpty(t *testing.T) {
	cfg := &cfdconfig.TunnelConfigV1{Token: "abc12345" + strings.Repeat("X", 100)}
	out, err := cfdconfig.MarshalYAML(cfg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(out)
	for _, banned := range []string{"edge:", "reliability:", "logging:", "identity:", "advancedEnvOverrides:", "binaryVersion:"} {
		if strings.Contains(s, banned) {
			t.Errorf("expected %q omitted with omitempty, got:\n%s", banned, s)
		}
	}
}

func TestParseJSON_RoundTripWithYAML(t *testing.T) {
	cfg, err := cfdconfig.ParseYAML([]byte(sampleYAML))
	if err != nil {
		t.Fatalf("parse yaml: %v", err)
	}
	jsonBytes, err := cfdconfig.MarshalJSON(cfg)
	if err != nil {
		t.Fatalf("marshal json: %v", err)
	}
	jc, err := cfdconfig.ParseJSON(jsonBytes)
	if err != nil {
		t.Fatalf("parse json: %v", err)
	}
	if jc.Edge.Protocol != cfg.Edge.Protocol {
		t.Errorf("json round-trip lost edge.protocol")
	}
	if jc.Identity.Tags["env"] != cfg.Identity.Tags["env"] {
		t.Errorf("json round-trip lost identity.tags[env]")
	}
}

func TestMarshalJSON_NilSafe(t *testing.T) {
	out, err := cfdconfig.MarshalJSON(nil)
	if err != nil {
		t.Fatalf("nil marshal: %v", err)
	}
	if string(out) != "null" {
		t.Errorf("expected 'null', got %q", string(out))
	}
}
```

- [ ] **Step 3.2 写 `pkg/cfdconfig/validate_test.go`**

```go
package cfdconfig_test

import (
	"strings"
	"testing"

	"github.com/mia-clark/cloudflared-manager/pkg/cfdconfig"
)

// validToken is a base64-ish 100-char string that satisfies the syntax
// check used by Validate; not a real cloudflared token.
var validToken = strings.Repeat("A", 100)

func TestValidate_NilReceiver(t *testing.T) {
	var c *cfdconfig.TunnelConfigV1
	if err := c.Validate(); err == nil {
		t.Fatal("expected ErrNilConfig")
	}
}

func TestValidate_EmptyDraft(t *testing.T) {
	c := &cfdconfig.TunnelConfigV1{}
	if err := c.Validate(); err != nil {
		t.Fatalf("empty draft should pass, got %v", err)
	}
}

func TestValidate_TokenTooShort(t *testing.T) {
	c := &cfdconfig.TunnelConfigV1{Token: "abc"}
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "token") {
		t.Fatalf("expected token length error, got %v", err)
	}
}

func TestValidate_TokenBadChar(t *testing.T) {
	bad := strings.Repeat("A", 99) + "!"
	c := &cfdconfig.TunnelConfigV1{Token: bad}
	if err := c.Validate(); err == nil {
		t.Fatal("expected token charset error")
	}
}

func TestValidate_ProtocolUnknown(t *testing.T) {
	c := &cfdconfig.TunnelConfigV1{
		Token: validToken,
		Edge:  cfdconfig.EdgeConfig{Protocol: "h3"},
	}
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "protocol") {
		t.Fatalf("expected protocol enum error, got %v", err)
	}
}

func TestValidate_EdgeIPVersionUnknown(t *testing.T) {
	c := &cfdconfig.TunnelConfigV1{
		Token: validToken,
		Edge:  cfdconfig.EdgeConfig{EdgeIPVersion: "v6"},
	}
	if err := c.Validate(); err == nil {
		t.Fatal("expected edgeIpVersion enum error")
	}
}

func TestValidate_RegionUnknown(t *testing.T) {
	c := &cfdconfig.TunnelConfigV1{
		Token: validToken,
		Edge:  cfdconfig.EdgeConfig{Region: "eu"},
	}
	if err := c.Validate(); err == nil {
		t.Fatal("expected region enum error")
	}
}

func TestValidate_RetriesOutOfRange(t *testing.T) {
	c := &cfdconfig.TunnelConfigV1{
		Token:       validToken,
		Reliability: cfdconfig.ReliabilityConfig{Retries: 50},
	}
	if err := c.Validate(); err == nil {
		t.Fatal("expected retries range error")
	}
}

func TestValidate_GracePeriodBadDuration(t *testing.T) {
	c := &cfdconfig.TunnelConfigV1{
		Token:       validToken,
		Reliability: cfdconfig.ReliabilityConfig{GracePeriod: "not-a-duration"},
	}
	if err := c.Validate(); err == nil {
		t.Fatal("expected grace period parse error")
	}
}

func TestValidate_GracePeriodOutOfRange(t *testing.T) {
	c := &cfdconfig.TunnelConfigV1{
		Token:       validToken,
		Reliability: cfdconfig.ReliabilityConfig{GracePeriod: "10m"},
	}
	if err := c.Validate(); err == nil {
		t.Fatal("expected grace period range error")
	}
}

func TestValidate_LogLevelUnknown(t *testing.T) {
	c := &cfdconfig.TunnelConfigV1{
		Token:   validToken,
		Logging: cfdconfig.LoggingConfig{LogLevel: "verbose"},
	}
	if err := c.Validate(); err == nil {
		t.Fatal("expected logLevel enum error")
	}
}

func TestValidate_LabelTooLong(t *testing.T) {
	c := &cfdconfig.TunnelConfigV1{
		Token:    validToken,
		Identity: cfdconfig.IdentityConfig{Label: strings.Repeat("a", 65)},
	}
	if err := c.Validate(); err == nil {
		t.Fatal("expected label length error")
	}
}

func TestValidate_LabelBadChar(t *testing.T) {
	c := &cfdconfig.TunnelConfigV1{
		Token:    validToken,
		Identity: cfdconfig.IdentityConfig{Label: "bad/slash"},
	}
	if err := c.Validate(); err == nil {
		t.Fatal("expected label charset error")
	}
}

func TestValidate_TagBadKey(t *testing.T) {
	c := &cfdconfig.TunnelConfigV1{
		Token:    validToken,
		Identity: cfdconfig.IdentityConfig{Tags: map[string]string{"1bad": "x"}},
	}
	if err := c.Validate(); err == nil {
		t.Fatal("expected tag key regex error")
	}
}

func TestValidate_AdvancedEnvReserved(t *testing.T) {
	c := &cfdconfig.TunnelConfigV1{
		Token:                validToken,
		AdvancedEnvOverrides: map[string]string{"TUNNEL_TOKEN": "x"},
	}
	if err := c.Validate(); err == nil {
		t.Fatal("expected reserved env error")
	}
}

func TestValidate_AdvancedEnvBadKey(t *testing.T) {
	c := &cfdconfig.TunnelConfigV1{
		Token:                validToken,
		AdvancedEnvOverrides: map[string]string{"lower_case": "x"},
	}
	if err := c.Validate(); err == nil {
		t.Fatal("expected env key regex error")
	}
}

func TestValidate_HappyPath(t *testing.T) {
	c := &cfdconfig.TunnelConfigV1{
		Token: validToken,
		Edge: cfdconfig.EdgeConfig{
			Protocol:      "auto",
			EdgeIPVersion: "4",
			Region:        "",
			PostQuantum:   false,
		},
		Reliability: cfdconfig.ReliabilityConfig{
			Retries:     5,
			GracePeriod: "30s",
		},
		Logging: cfdconfig.LoggingConfig{
			LogLevel:          "info",
			TransportLogLevel: "info",
		},
		Identity: cfdconfig.IdentityConfig{
			Label: "home-nas",
			Tags:  map[string]string{"env": "prod"},
		},
		AdvancedEnvOverrides: map[string]string{"TUNNEL_DNS_RESOLVER_ADDRS": "1.1.1.1"},
		BinaryVersion:        "2026.5.2",
	}
	if err := c.Validate(); err != nil {
		t.Fatalf("happy path failed: %v", err)
	}
}
```

- [ ] **Step 3.3 跑测试**

```bash
go test ./pkg/cfdconfig/... -v 2>&1 | tail -30
```

Expected: 全部 PASS（~20+ test cases）。

---

## Task 4：创建 pkg/cfdflags

**Files:**
- Create: `pkg/cfdflags/flags.go`
- Create: `pkg/cfdflags/mapping.go`
- Create: `pkg/cfdflags/whitelist.go`
- Create: `pkg/cfdflags/alerts.go`

- [ ] **Step 4.1 mkdir + 写 `pkg/cfdflags/flags.go`**

```bash
mkdir -p pkg/cfdflags
```

内容：

```go
// Package cfdflags provides metadata about every cloudflared CLI flag
// the manager UI is willing to expose, together with the mapping from
// our YAML / JSON config tree onto the TUNNEL_* environment variables
// the cloudflared subprocess actually consumes.
//
// Three rules govern this package:
//
//   1. token-mode only — flags that only matter for `tunnel login` /
//      `route` / quick tunnels / origin config (ingress, proxy-*-timeout
//      etc.) are NOT modelled here. Those configurations live in the
//      Cloudflare Zero Trust dashboard.
//   2. env > argv — every modelled flag declares its TUNNEL_* env name
//      so cfdmgrd can inject values into the child process env. The one
//      documented exception is the connector label (no TUNNEL_LABEL env
//      exists upstream); see Mapping for how it is handled.
//   3. cfdmgrd-mandated env is reserved — TUNNEL_TOKEN / NO_AUTOUPDATE
//      / TUNNEL_METRICS / TUNNEL_OUTPUT are always set by cfdmgrd
//      itself and rejected from AdvancedEnvOverrides.
package cfdflags

// Group identifies the UI tab a flag belongs to in the configuration
// form. The values double as i18n keys.
type Group string

const (
	GroupEdge        Group = "edge"
	GroupReliability Group = "reliability"
	GroupLogging     Group = "logging"
	GroupIdentity    Group = "identity"
	GroupAdvanced    Group = "advanced"
)

// ControlKind drives the kind of widget rendered for each flag.
type ControlKind string

const (
	ControlSelect   ControlKind = "select"
	ControlSwitch   ControlKind = "switch"
	ControlNumber   ControlKind = "number"
	ControlText     ControlKind = "text"
	ControlDuration ControlKind = "duration"
	ControlChips    ControlKind = "chips"
)

// Flag describes one user-exposable flag.
type Flag struct {
	YAMLPath   string      // dot path inside TunnelConfigV1, e.g. "edge.protocol"
	CLIFlag    string      // cloudflared CLI flag including dashes, e.g. "--protocol"
	EnvName    string      // TUNNEL_* env var; empty means "argv only" (Label)
	Group      Group       // UI group
	Control    ControlKind // widget kind
	Enum       []string    // non-nil for ControlSelect
	Default    string      // textual default for documentation
	HelpText   string      // one-liner shown under the widget
	Advanced   bool        // hidden behind a "show advanced" toggle
}

// All returns the full set of modelled flags in display order. The
// slice is freshly allocated per call so callers may mutate it safely.
func All() []Flag {
	out := make([]Flag, len(registry))
	copy(out, registry)
	return out
}

// ByEnvName indexes registry by EnvName, skipping flags whose EnvName
// is empty (currently just identity.label). Result is a fresh map.
func ByEnvName() map[string]Flag {
	m := make(map[string]Flag, len(registry))
	for _, f := range registry {
		if f.EnvName != "" {
			m[f.EnvName] = f
		}
	}
	return m
}

// registry is the canonical metadata table. Keep it sorted by YAMLPath
// so reviews diff cleanly.
var registry = []Flag{
	{
		YAMLPath: "edge.protocol",
		CLIFlag:  "--protocol",
		EnvName:  "TUNNEL_TRANSPORT_PROTOCOL",
		Group:    GroupEdge,
		Control:  ControlSelect,
		Enum:     []string{"auto", "http2", "quic"},
		Default:  "auto",
		HelpText: "Transport protocol between this connector and the Cloudflare edge.",
	},
	{
		YAMLPath: "edge.edgeIpVersion",
		CLIFlag:  "--edge-ip-version",
		EnvName:  "TUNNEL_EDGE_IP_VERSION",
		Group:    GroupEdge,
		Control:  ControlSelect,
		Enum:     []string{"auto", "4", "6"},
		Default:  "4",
		HelpText: "IP family used to reach the edge.",
	},
	{
		YAMLPath: "edge.edgeBindAddress",
		CLIFlag:  "--edge-bind-address",
		EnvName:  "TUNNEL_EDGE_BIND_ADDRESS",
		Group:    GroupEdge,
		Control:  ControlText,
		Default:  "",
		HelpText: "Pin a local source IP for outbound edge dials. Leave empty for OS default.",
		Advanced: true,
	},
	{
		YAMLPath: "edge.region",
		CLIFlag:  "--region",
		EnvName:  "TUNNEL_REGION",
		Group:    GroupEdge,
		Control:  ControlSelect,
		Enum:     []string{"", "us"},
		Default:  "",
		HelpText: "Restrict edge routing to a region. Empty = global.",
	},
	{
		YAMLPath: "edge.postQuantum",
		CLIFlag:  "--post-quantum",
		EnvName:  "TUNNEL_POST_QUANTUM",
		Group:    GroupEdge,
		Control:  ControlSwitch,
		Default:  "false",
		HelpText: "Force a post-quantum key exchange. Only effective when protocol=quic.",
		Advanced: true,
	},
	{
		YAMLPath: "reliability.retries",
		CLIFlag:  "--retries",
		EnvName:  "TUNNEL_RETRIES",
		Group:    GroupReliability,
		Control:  ControlNumber,
		Default:  "5",
		HelpText: "Number of connection / protocol retries before giving up. Range 1-20.",
	},
	{
		YAMLPath: "reliability.gracePeriod",
		CLIFlag:  "--grace-period",
		EnvName:  "TUNNEL_GRACE_PERIOD",
		Group:    GroupReliability,
		Control:  ControlDuration,
		Default:  "30s",
		HelpText: "How long to wait for in-flight requests on SIGTERM. Range 1s..5m.",
	},
	{
		YAMLPath: "logging.logLevel",
		CLIFlag:  "--loglevel",
		EnvName:  "TUNNEL_LOGLEVEL",
		Group:    GroupLogging,
		Control:  ControlSelect,
		Enum:     []string{"debug", "info", "warn", "error", "fatal"},
		Default:  "info",
		HelpText: "Application log verbosity. debug records request URLs and headers (sensitive).",
	},
	{
		YAMLPath: "logging.transportLogLevel",
		CLIFlag:  "--transport-loglevel",
		EnvName:  "TUNNEL_TRANSPORT_LOGLEVEL",
		Group:    GroupLogging,
		Control:  ControlSelect,
		Enum:     []string{"debug", "info", "warn", "error", "fatal"},
		Default:  "info",
		HelpText: "Transport (QUIC/HTTP2) log verbosity.",
		Advanced: true,
	},
	{
		YAMLPath: "identity.label",
		CLIFlag:  "--label",
		EnvName:  "", // <-- no env var upstream; argv passthrough
		Group:    GroupIdentity,
		Control:  ControlText,
		Default:  "",
		HelpText: "Connector display name shown in the Zero Trust dashboard.",
	},
	{
		YAMLPath: "identity.tags",
		CLIFlag:  "--tag",
		EnvName:  "TUNNEL_TAG",
		Group:    GroupIdentity,
		Control:  ControlChips,
		Default:  "",
		HelpText: "Key=value annotations forwarded to the dashboard.",
		Advanced: true,
	},
}
```

- [ ] **Step 4.2 写 `pkg/cfdflags/mapping.go`**

内容：

```go
package cfdflags

import (
	"fmt"
	"sort"
	"strings"
)

// Options is the decoupled input shape for ToTunnelEnv. The PR-04
// internal/process layer is responsible for projecting a
// pkg/cfdconfig.TunnelConfigV1 onto this struct before invoking the
// mapping. The duplication is intentional: cfdflags must not import
// cfdconfig (would create a back-edge in the dependency graph).
type Options struct {
	Protocol          string
	EdgeIPVersion     string
	EdgeBindAddress   string
	Region            string
	PostQuantum       bool
	Retries           int
	GracePeriod       string
	LogLevel          string
	TransportLogLevel string
	Tags              map[string]string

	// Label is handled separately by the caller (see LabelArgv) because
	// it has no TUNNEL_LABEL env var upstream.
	Label string

	// AdvancedEnvOverrides flows through verbatim after dropping
	// reserved keys. See whitelist.go.
	AdvancedEnvOverrides map[string]string
}

// ToTunnelEnv maps Options onto the TUNNEL_* env vars cloudflared
// understands. Empty / zero values are skipped so the child process
// inherits cloudflared upstream defaults for those slots.
//
// The cfdmgrd-mandated env (TUNNEL_TOKEN, NO_AUTOUPDATE, TUNNEL_METRICS,
// TUNNEL_OUTPUT) is NOT set here — the spawn helper injects those after
// merging the user env so they always win.
func ToTunnelEnv(o Options) map[string]string {
	out := make(map[string]string, 16)

	if o.Protocol != "" {
		out["TUNNEL_TRANSPORT_PROTOCOL"] = o.Protocol
	}
	if o.EdgeIPVersion != "" {
		out["TUNNEL_EDGE_IP_VERSION"] = o.EdgeIPVersion
	}
	if o.EdgeBindAddress != "" {
		out["TUNNEL_EDGE_BIND_ADDRESS"] = o.EdgeBindAddress
	}
	if o.Region != "" {
		out["TUNNEL_REGION"] = o.Region
	}
	if o.PostQuantum {
		out["TUNNEL_POST_QUANTUM"] = "true"
	}
	if o.Retries > 0 {
		out["TUNNEL_RETRIES"] = fmt.Sprintf("%d", o.Retries)
	}
	if o.GracePeriod != "" {
		out["TUNNEL_GRACE_PERIOD"] = o.GracePeriod
	}
	if o.LogLevel != "" {
		out["TUNNEL_LOGLEVEL"] = o.LogLevel
	}
	if o.TransportLogLevel != "" {
		out["TUNNEL_TRANSPORT_LOGLEVEL"] = o.TransportLogLevel
	}
	if t := formatTags(o.Tags); t != "" {
		out["TUNNEL_TAG"] = t
	}
	for k, v := range o.AdvancedEnvOverrides {
		if AllowEnvOverride(k) {
			out[k] = v
		}
	}
	return out
}

// LabelArgv returns the argv fragment cfdmgrd should append to the
// cloudflared command for the connector label. cloudflared does NOT
// expose a TUNNEL_LABEL env var, so this is the one place we cannot
// avoid argv. Returns nil when label is empty.
func LabelArgv(label string) []string {
	label = strings.TrimSpace(label)
	if label == "" {
		return nil
	}
	return []string{"--label", label}
}

// formatTags joins a tag map into the comma-separated "k1=v1,k2=v2"
// format cloudflared expects for TUNNEL_TAG. Keys are sorted to keep
// the output deterministic across runs (useful for test snapshots and
// for diffing the environment in audit logs).
func formatTags(tags map[string]string) string {
	if len(tags) == 0 {
		return ""
	}
	keys := make([]string, 0, len(tags))
	for k := range tags {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+tags[k])
	}
	return strings.Join(parts, ",")
}
```

- [ ] **Step 4.3 写 `pkg/cfdflags/whitelist.go`**

内容：

```go
package cfdflags

// AllowEnvOverride decides whether a key from
// TunnelConfigV1.AdvancedEnvOverrides may be injected into the child
// process environment. The policy:
//
//   - any modelled TUNNEL_* flag's EnvName is allowed (so users can
//     express the same setting via the escape hatch if they prefer);
//   - a small additional allowlist of "advanced but harmless" TUNNEL_*
//     vars is included for compat with debugging scenarios;
//   - anything cfdmgrd manages itself (TUNNEL_TOKEN, NO_AUTOUPDATE,
//     TUNNEL_METRICS, TUNNEL_OUTPUT, TUNNEL_LOGFILE, TUNNEL_LOGDIRECTORY,
//     AUTOUPDATE_FREQ) is REJECTED;
//   - everything else is rejected.
func AllowEnvOverride(envName string) bool {
	if reservedOverride[envName] {
		return false
	}
	if modelledEnv[envName] {
		return true
	}
	if extraAllowed[envName] {
		return true
	}
	return false
}

// reservedOverride contains keys cfdmgrd injects itself; users must
// not be able to override them via AdvancedEnvOverrides.
var reservedOverride = map[string]bool{
	"TUNNEL_TOKEN":        true,
	"NO_AUTOUPDATE":       true,
	"AUTOUPDATE_FREQ":     true,
	"TUNNEL_METRICS":      true,
	"TUNNEL_OUTPUT":       true,
	"TUNNEL_LOGFILE":      true,
	"TUNNEL_LOGDIRECTORY": true,
}

// modelledEnv is populated lazily from registry on first use; the
// invariant "every Flag.EnvName not in reservedOverride is allowed"
// keeps the data sources in sync.
var modelledEnv = func() map[string]bool {
	m := make(map[string]bool, len(registry))
	for _, f := range registry {
		if f.EnvName != "" && !reservedOverride[f.EnvName] {
			m[f.EnvName] = true
		}
	}
	return m
}()

// extraAllowed names env vars that don't correspond to a modelled flag
// but are sometimes useful for power users. Keep this list short.
var extraAllowed = map[string]bool{
	"TUNNEL_DNS_RESOLVER_ADDRS":   true, // cloudflared 2025.7+ custom resolver list
	"TUNNEL_METRICS_UPDATE_FREQ":  true, // metrics scrape interval (display only)
	"TUNNEL_MANAGEMENT_DIAGNOSTICS": true, // enable /debug/pprof through CF mgmt
}
```

- [ ] **Step 4.4 写 `pkg/cfdflags/alerts.go`**

内容：

```go
package cfdflags

import "time"

// Severity classifies an alert's urgency.
type Severity string

const (
	SeverityInfo     Severity = "info"
	SeverityWarning  Severity = "warning"
	SeverityCritical Severity = "critical"
)

// AlertRuleTemplate is the metadata describing one factory-default
// alert rule. The expression column uses PromQL-flavoured pseudo-code;
// the actual evaluator in internal/metrics/sampler will translate
// against the SQLite series schema.
type AlertRuleTemplate struct {
	ID          string        // stable identifier, used as default rule_id in DB
	Name        string        // human label
	Expr        string        // PromQL-style expression (advisory)
	Threshold   string        // canonical default threshold as text
	For         time.Duration // dampening window
	Severity    Severity
	Description string
}

// DefaultAlertTemplates returns the 12 factory-default alert rules.
// The slice is freshly allocated so callers may mutate it safely.
func DefaultAlertTemplates() []AlertRuleTemplate {
	out := make([]AlertRuleTemplate, len(defaultAlertTemplates))
	copy(out, defaultAlertTemplates)
	return out
}

var defaultAlertTemplates = []AlertRuleTemplate{
	{
		ID:          "ha_degraded",
		Name:        "HA 连接不足",
		Expr:        "ha_connections < 4",
		Threshold:   "< 4",
		For:         2 * time.Minute,
		Severity:    SeverityWarning,
		Description: "默认 4 条 HA 连接，缺 1 条持续 2 分钟即告警。",
	},
	{
		ID:          "ha_disconnected",
		Name:        "HA 全部断开",
		Expr:        "ha_connections == 0",
		Threshold:   "== 0",
		For:         30 * time.Second,
		Severity:    SeverityCritical,
		Description: "0 条连接 = 隧道完全离线，对应 /ready 返回 503。",
	},
	{
		ID:          "ready_probe_failed",
		Name:        "/ready 探针失败",
		Expr:        "ready_probe_failures >= 3",
		Threshold:   ">= 3 次连续 503/超时",
		For:         0,
		Severity:    SeverityCritical,
		Description: "覆盖 metrics 端点本身挂掉的情况，与 HA 全断互为冗余。",
	},
	{
		ID:          "reconnect_storm",
		Name:        "重连风暴",
		Expr:        "rate(tunnel_register_success[5m]) > 0.1",
		Threshold:   "> 6 次/分钟",
		For:         5 * time.Minute,
		Severity:    SeverityWarning,
		Description: "稳态下 register_success 不应持续增长。",
	},
	{
		ID:          "http_5xx_ratio_high",
		Name:        "5xx 占比过高",
		Expr:        "sum(rate(resp_5xx[5m])) / sum(rate(resp_all[5m])) > 0.05",
		Threshold:   "> 5%",
		For:         5 * time.Minute,
		Severity:    SeverityWarning,
		Description: "> 20% 应升级为 critical（由 sampler 双阈值实现）。",
	},
	{
		ID:          "request_errors_high",
		Name:        "请求错误激增",
		Expr:        "rate(request_errors[5m]) > 1",
		Threshold:   "> 1 次/秒",
		For:         5 * time.Minute,
		Severity:    SeverityWarning,
		Description: "request_errors 是 cloudflared 自身无法完成的请求。",
	},
	{
		ID:          "quic_rtt_high",
		Name:        "QUIC 高 RTT",
		Expr:        "avg(smoothed_rtt) > 300",
		Threshold:   "> 300 ms",
		For:         10 * time.Minute,
		Severity:    SeverityWarning,
		Description: "smoothed_rtt 持续 > 300ms 显著影响用户体验。",
	},
	{
		ID:          "quic_packet_loss_high",
		Name:        "QUIC 丢包高",
		Expr:        "rate(lost_packets[5m]) > 5",
		Threshold:   "> 5 包/秒",
		For:         5 * time.Minute,
		Severity:    SeverityWarning,
		Description: "链路质量下降信号。",
	},
	{
		ID:          "udp_dropped_high",
		Name:        "UDP 丢报文",
		Expr:        "rate(udp_dropped_datagrams[5m]) > 1",
		Threshold:   "> 1/s",
		For:         5 * time.Minute,
		Severity:    SeverityWarning,
		Description: "仅当用户开启了 UDP / private network 时有意义。",
	},
	{
		ID:          "rss_high",
		Name:        "内存异常",
		Expr:        "process_resident_memory_bytes > 500 * 1024 * 1024",
		Threshold:   "> 500 MiB",
		For:         15 * time.Minute,
		Severity:    SeverityWarning,
		Description: "正常稳态 50-150 MiB；> 1 GiB 升级 critical。",
	},
	{
		ID:          "goroutines_high",
		Name:        "Goroutine 泄漏",
		Expr:        "go_goroutines > 5000",
		Threshold:   "> 5000",
		For:         30 * time.Minute,
		Severity:    SeverityWarning,
		Description: "正常 100-500；长期高位说明 leak。",
	},
	{
		ID:          "process_restarted",
		Name:        "进程刚重启",
		Expr:        "time() - process_start_time_seconds < 60",
		Threshold:   "< 60 s",
		For:         0,
		Severity:    SeverityInfo,
		Description: "仅记录用，与重连风暴配合识别 flapping。",
	},
}
```

- [ ] **Step 4.5 单包 vet**

```bash
go vet ./pkg/cfdflags/...
```

Expected: exit 0。

---

## Task 5：写 cfdflags 测试

**Files:**
- Create: `pkg/cfdflags/flags_test.go`
- Create: `pkg/cfdflags/whitelist_test.go`

- [ ] **Step 5.1 写 `pkg/cfdflags/flags_test.go`**

```go
package cfdflags_test

import (
	"testing"

	"github.com/mia-clark/cloudflared-manager/pkg/cfdflags"
)

func TestAll_Count(t *testing.T) {
	flags := cfdflags.All()
	if n := len(flags); n < 10 {
		t.Fatalf("registry shrunk unexpectedly: %d flags", n)
	}
}

func TestAll_NoDuplicateYAMLPath(t *testing.T) {
	seen := map[string]bool{}
	for _, f := range cfdflags.All() {
		if seen[f.YAMLPath] {
			t.Errorf("duplicate YAMLPath %q", f.YAMLPath)
		}
		seen[f.YAMLPath] = true
	}
}

func TestAll_NoDuplicateEnvName(t *testing.T) {
	seen := map[string]bool{}
	for _, f := range cfdflags.All() {
		if f.EnvName == "" {
			continue
		}
		if seen[f.EnvName] {
			t.Errorf("duplicate EnvName %q", f.EnvName)
		}
		seen[f.EnvName] = true
	}
}

func TestAll_LabelHasNoEnv(t *testing.T) {
	for _, f := range cfdflags.All() {
		if f.YAMLPath == "identity.label" && f.EnvName != "" {
			t.Errorf("identity.label unexpectedly has EnvName=%q; cloudflared exposes no TUNNEL_LABEL", f.EnvName)
		}
	}
}

func TestByEnvName_OmitsLabel(t *testing.T) {
	m := cfdflags.ByEnvName()
	for env := range m {
		if env == "" {
			t.Error("ByEnvName included empty key")
		}
	}
}

func TestByEnvName_HasProtocol(t *testing.T) {
	m := cfdflags.ByEnvName()
	if _, ok := m["TUNNEL_TRANSPORT_PROTOCOL"]; !ok {
		t.Error("expected TUNNEL_TRANSPORT_PROTOCOL in ByEnvName")
	}
}

func TestToTunnelEnv_OmitZero(t *testing.T) {
	out := cfdflags.ToTunnelEnv(cfdflags.Options{})
	if n := len(out); n != 0 {
		t.Fatalf("zero options should produce empty map, got %d entries: %+v", n, out)
	}
}

func TestToTunnelEnv_Happy(t *testing.T) {
	out := cfdflags.ToTunnelEnv(cfdflags.Options{
		Protocol:          "auto",
		EdgeIPVersion:     "4",
		Region:            "us",
		PostQuantum:       true,
		Retries:           5,
		GracePeriod:       "30s",
		LogLevel:          "info",
		TransportLogLevel: "warn",
		Tags:              map[string]string{"site": "shanghai", "env": "prod"},
		AdvancedEnvOverrides: map[string]string{
			"TUNNEL_DNS_RESOLVER_ADDRS": "1.1.1.1",
			"TUNNEL_TOKEN":              "abc", // reserved, should drop
			"BOGUS":                     "x",   // not allowed, should drop
		},
	})
	expect := map[string]string{
		"TUNNEL_TRANSPORT_PROTOCOL": "auto",
		"TUNNEL_EDGE_IP_VERSION":    "4",
		"TUNNEL_REGION":             "us",
		"TUNNEL_POST_QUANTUM":       "true",
		"TUNNEL_RETRIES":            "5",
		"TUNNEL_GRACE_PERIOD":       "30s",
		"TUNNEL_LOGLEVEL":           "info",
		"TUNNEL_TRANSPORT_LOGLEVEL": "warn",
		"TUNNEL_TAG":                "env=prod,site=shanghai",
		"TUNNEL_DNS_RESOLVER_ADDRS": "1.1.1.1",
	}
	if len(out) != len(expect) {
		t.Errorf("len mismatch: got %d want %d (%+v)", len(out), len(expect), out)
	}
	for k, v := range expect {
		if out[k] != v {
			t.Errorf("env %s: got %q want %q", k, out[k], v)
		}
	}
	if _, leaked := out["TUNNEL_TOKEN"]; leaked {
		t.Error("reserved TUNNEL_TOKEN leaked through AdvancedEnvOverrides")
	}
	if _, leaked := out["BOGUS"]; leaked {
		t.Error("BOGUS leaked through AdvancedEnvOverrides")
	}
}

func TestLabelArgv_Empty(t *testing.T) {
	if got := cfdflags.LabelArgv(""); got != nil {
		t.Errorf("empty label should return nil, got %v", got)
	}
	if got := cfdflags.LabelArgv("   "); got != nil {
		t.Errorf("whitespace label should return nil, got %v", got)
	}
}

func TestLabelArgv_NonEmpty(t *testing.T) {
	got := cfdflags.LabelArgv("home-nas")
	want := []string{"--label", "home-nas"}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("LabelArgv home-nas = %v, want %v", got, want)
	}
}

func TestDefaultAlertTemplates_Count(t *testing.T) {
	tpls := cfdflags.DefaultAlertTemplates()
	if n := len(tpls); n != 12 {
		t.Fatalf("expected 12 default templates, got %d", n)
	}
}

func TestDefaultAlertTemplates_StableIDs(t *testing.T) {
	wantIDs := []string{
		"ha_degraded", "ha_disconnected", "ready_probe_failed",
		"reconnect_storm", "http_5xx_ratio_high", "request_errors_high",
		"quic_rtt_high", "quic_packet_loss_high", "udp_dropped_high",
		"rss_high", "goroutines_high", "process_restarted",
	}
	tpls := cfdflags.DefaultAlertTemplates()
	for i, want := range wantIDs {
		if tpls[i].ID != want {
			t.Errorf("template[%d] id = %q, want %q", i, tpls[i].ID, want)
		}
	}
}
```

- [ ] **Step 5.2 写 `pkg/cfdflags/whitelist_test.go`**

```go
package cfdflags_test

import (
	"testing"

	"github.com/mia-clark/cloudflared-manager/pkg/cfdflags"
)

func TestAllowEnvOverride_Reserved(t *testing.T) {
	for _, env := range []string{
		"TUNNEL_TOKEN", "NO_AUTOUPDATE", "AUTOUPDATE_FREQ",
		"TUNNEL_METRICS", "TUNNEL_OUTPUT", "TUNNEL_LOGFILE",
		"TUNNEL_LOGDIRECTORY",
	} {
		if cfdflags.AllowEnvOverride(env) {
			t.Errorf("reserved env %q was allowed", env)
		}
	}
}

func TestAllowEnvOverride_Modelled(t *testing.T) {
	for _, env := range []string{
		"TUNNEL_TRANSPORT_PROTOCOL", "TUNNEL_EDGE_IP_VERSION",
		"TUNNEL_REGION", "TUNNEL_RETRIES", "TUNNEL_GRACE_PERIOD",
		"TUNNEL_LOGLEVEL", "TUNNEL_TAG",
	} {
		if !cfdflags.AllowEnvOverride(env) {
			t.Errorf("modelled env %q was rejected", env)
		}
	}
}

func TestAllowEnvOverride_Extra(t *testing.T) {
	for _, env := range []string{
		"TUNNEL_DNS_RESOLVER_ADDRS",
		"TUNNEL_METRICS_UPDATE_FREQ",
		"TUNNEL_MANAGEMENT_DIAGNOSTICS",
	} {
		if !cfdflags.AllowEnvOverride(env) {
			t.Errorf("extra allowed env %q was rejected", env)
		}
	}
}

func TestAllowEnvOverride_RandomKey(t *testing.T) {
	if cfdflags.AllowEnvOverride("PATH") {
		t.Error("PATH should not be allowed")
	}
	if cfdflags.AllowEnvOverride("RANDOM_NEW_FLAG") {
		t.Error("RANDOM_NEW_FLAG should not be allowed")
	}
}
```

- [ ] **Step 5.3 跑测试**

```bash
go test ./pkg/cfdflags/... -v 2>&1 | tail -40
```

Expected: 全部 PASS。

---

## Task 6：全量验证

- [ ] **Step 6.1 vet + test + build**

```bash
go vet ./... && go test ./... && go build -o bin/cfdmgrd ./cmd/cfdmgrd && ./bin/cfdmgrd version
```

Expected:
- vet exit 0
- test 全 PASS
- build exit 0
- version 输出 `cfdmgrd ... (built ...)`

- [ ] **Step 6.2 gofmt 校对**

```bash
gofmt -l pkg/cfdconfig/ pkg/cfdflags/
```

Expected: 无输出。如有 → 直接 `gofmt -w` 修复对应文件。

- [ ] **Step 6.3 启动 smoke 验证（仍能跑）**

```bash
rm -rf ./tmp/data; mkdir -p ./tmp/data
CFDM_API_TOKEN=dev CFDM_DATA_DIR=./tmp/data ./bin/cfdmgrd serve > /tmp/cfdmgrd-pr03.log 2>&1 &
SERVE_PID=$!
sleep 2
curl -fsS http://127.0.0.1:8080/api/v1/health
echo
curl -fsS -H "Authorization: Bearer dev" http://127.0.0.1:8080/api/v1/configs
echo
kill $SERVE_PID 2>/dev/null
sleep 1
rm -rf ./tmp/data /tmp/cfdmgrd-pr03.log
```

Expected: `/health` 200，`/configs` 返回空列表。

---

## Task 7：commit（controller 主线）

- [ ] git add + commit（commit message 见下方）

---

## Self-Review

✅ **Spec 覆盖**（spec §1.2 + §2 + §5.4）：
- TunnelConfigV1 struct → Task 2 / `tunnel.go`
- YAML 双向编解码 → Task 2 / `codec.go`
- 基础校验 → Task 2 / `validate.go` + Task 3 测试
- cloudflared flag 元数据 → Task 4 / `flags.go`
- flag↔env 映射 + LabelArgv → Task 4 / `mapping.go`
- env 白名单 → Task 4 / `whitelist.go`
- 12 条告警模板 → Task 4 / `alerts.go`
- 完整测试覆盖（≥ 30 个 test case） → Task 3 + Task 5

✅ **类型一致性**：
- `Options.Protocol/EdgeIPVersion/Region/...` 字段与 `cfdconfig.EdgeConfig` 同名同语义，便于 PR-04 直接做"projection"映射
- `Flag.YAMLPath` 与 `TunnelConfigV1` 字段路径一一对应（前缀 `edge.` / `reliability.` / `logging.` / `identity.`）
- `reservedEnv`（cfdconfig）和 `reservedOverride`（cfdflags）名字略有差异但语义一致 — **故意**，因为 cfdconfig 不应反向依赖 cfdflags

✅ **依赖方向**：
- `cfdconfig` 没有 import `cfdflags`，也没有反向
- 两包都不 import `pkg/util` / `pkg/config` / `internal/*`
- 两包都不 import `fatedier/frp`

✅ **占位符扫描**：
- 无 TBD / TODO / FIXME 残留
- 每个 step 含完整代码 + 命令 + 期望输出

---

## Execution Handoff

用 subagent-driven-development 执行：两个 batch 分开（Batch I：cfdconfig（Task 1-3），Batch II：cfdflags（Task 4-5），Batch III：全量验证 + commit（Task 6-7））。
