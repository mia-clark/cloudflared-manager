package appcfg

import (
	"errors"
	"os"
	"runtime"
	"strings"
	"time"
)

// Config is the daemon's own runtime configuration, populated from env vars.
type Config struct {
	HTTPAddr    string
	APIToken    string
	CORSOrigins []string
	DataDir     string
	ProfilesDir string
	LogsDir     string
	StoresDir   string
	MetaFile    string
	LogLevel    string
	DocsEnabled bool
	// SelfUpdateEnabled gates the web-triggered self-update endpoint
	// (POST /api/v1/system/update). It maps to CFDM_SELF_UPDATE_ENABLED
	// and defaults to true. Operators running immutable deployments can set
	// it to false to disable in-place upgrades from the UI.
	SelfUpdateEnabled bool
	ShutdownWait      time.Duration
}

// Load reads configuration from environment variables. Required fields
// without sensible defaults will return an error.
func Load() (*Config, error) {
	cfg := &Config{
		HTTPAddr:    getEnv("CFDM_HTTP_ADDR", ":8080"),
		APIToken:    os.Getenv("CFDM_API_TOKEN"),
		CORSOrigins: splitCSV(getEnv("CFDM_CORS_ORIGINS", "*")),
		DataDir:     getEnv("CFDM_DATA_DIR", defaultDataDir()),
		LogLevel:    strings.ToLower(getEnv("CFDM_LOG_LEVEL", "info")),
		DocsEnabled: parseBool(getEnv("CFDM_DOCS_ENABLED", "true"), true),

		SelfUpdateEnabled: parseBool(getEnv("CFDM_SELF_UPDATE_ENABLED", "true"), true),
		ShutdownWait:      10 * time.Second,
	}
	cfg.ProfilesDir = cfg.DataDir + "/profiles"
	cfg.LogsDir = cfg.DataDir + "/logs"
	cfg.StoresDir = cfg.DataDir + "/stores"
	cfg.MetaFile = cfg.DataDir + "/meta.json"

	if cfg.APIToken == "" {
		return nil, errors.New("CFDM_API_TOKEN is required")
	}
	return cfg, nil
}

// EnsureDirs creates the data subdirectories if they do not exist.
func (c *Config) EnsureDirs() error {
	for _, d := range []string{c.DataDir, c.ProfilesDir, c.LogsDir, c.StoresDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	return nil
}

// defaultDataDir picks a sane default per OS. The installer scripts and
// Dockerfile override CFDM_DATA_DIR explicitly so this only matters when
// users run cfdmgrd by hand without env vars set.
func defaultDataDir() string {
	// Windows: %ProgramData%\cfdmgrd 由安装脚本注入；缺失时回 C:\cfdmgrd
	// Linux/Darwin: /var/lib/cfdmgrd
	if runtime.GOOS == "windows" {
		if p := os.Getenv("ProgramData"); p != "" {
			return p + `\cfdmgrd`
		}
		return `C:\cfdmgrd`
	}
	return "/var/lib/cfdmgrd"
}

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func parseBool(s string, def bool) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on", "y":
		return true
	case "0", "false", "no", "off", "n":
		return false
	default:
		return def
	}
}

func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
