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
