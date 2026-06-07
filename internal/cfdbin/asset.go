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
