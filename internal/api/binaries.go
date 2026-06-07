package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/mia-clark/cloudflared-manager/internal/cfdbin"
)

// BinariesHandler exposes the /api/v1/binaries/* endpoints.
type BinariesHandler struct {
	store  *cfdbin.Store
	dl     *cfdbin.Downloader
	logger *slog.Logger
}

// NewBinariesHandler constructs a handler. store and dl may be nil; in that
// case every mutating endpoint returns 503.
func NewBinariesHandler(store *cfdbin.Store, dl *cfdbin.Downloader, logger *slog.Logger) *BinariesHandler {
	return &BinariesHandler{store: store, dl: dl, logger: logger}
}

// List returns all locally installed cloudflared versions.
//
// GET /api/v1/binaries
func (h *BinariesHandler) List(w http.ResponseWriter, r *http.Request) {
	if h.store == nil {
		WriteJSON(w, http.StatusOK, map[string]any{"items": []any{}})
		return
	}
	items, err := h.store.List()
	if err != nil {
		WriteError(w, http.StatusInternalServerError, CodeInternal, "list binaries: "+err.Error(), nil)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

// Available returns releases available for download from GitHub.
//
// GET /api/v1/binaries/available
func (h *BinariesHandler) Available(w http.ResponseWriter, r *http.Request) {
	if h.dl == nil {
		WriteError(w, http.StatusServiceUnavailable, CodeInternal, "downloader not configured", nil)
		return
	}
	items, err := h.dl.Available(r.Context(), 10)
	if err != nil {
		WriteError(w, http.StatusBadGateway, CodeUpstreamFailure, "fetch releases: "+err.Error(), nil)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

// Install downloads and stores a cloudflared binary.
//
// POST /api/v1/binaries/install
// Body: {"version":"2026.5.2"}  — version is required.
func (h *BinariesHandler) Install(w http.ResponseWriter, r *http.Request) {
	if h.store == nil || h.dl == nil {
		WriteError(w, http.StatusServiceUnavailable, CodeInternal, "binary store not configured", nil)
		return
	}
	var body struct {
		Version string `json:"version"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.Version == "" {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "version is required", nil)
		return
	}

	// Run the potentially long download in the request context so the client
	// can cancel it. Timeouts should be set by a reverse proxy / the caller.
	meta, err := h.store.Install(r.Context(), h.dl, body.Version)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			WriteError(w, http.StatusGatewayTimeout, CodeInternal, "download cancelled or timed out", nil)
			return
		}
		WriteError(w, http.StatusBadGateway, CodeUpstreamFailure, "install: "+err.Error(), nil)
		return
	}

	h.logger.Info("binary installed", slog.String("version", meta.Version), slog.String("sha256", meta.SHA256))
	WriteJSON(w, http.StatusCreated, meta)
}

// Activate sets the active cloudflared version.
//
// POST /api/v1/binaries/{version}/activate
func (h *BinariesHandler) Activate(w http.ResponseWriter, r *http.Request) {
	if h.store == nil {
		WriteError(w, http.StatusServiceUnavailable, CodeInternal, "binary store not configured", nil)
		return
	}
	version := pathVersion(r)
	if version == "" {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "version path parameter is required", nil)
		return
	}
	if err := h.store.Activate(version); err != nil {
		if errors.Is(err, cfdbin.ErrNotInstalled) {
			WriteError(w, http.StatusNotFound, CodeNotFound, err.Error(), nil)
			return
		}
		WriteError(w, http.StatusInternalServerError, CodeInternal, "activate: "+err.Error(), nil)
		return
	}
	h.logger.Info("binary activated", slog.String("version", version))
	WriteJSON(w, http.StatusOK, map[string]any{"version": version, "active": true})
}

// Delete removes an installed version from the store.
//
// DELETE /api/v1/binaries/{version}
func (h *BinariesHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if h.store == nil {
		WriteError(w, http.StatusServiceUnavailable, CodeInternal, "binary store not configured", nil)
		return
	}
	version := pathVersion(r)
	if version == "" {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "version path parameter is required", nil)
		return
	}
	if err := h.store.Delete(version); err != nil {
		if errors.Is(err, cfdbin.ErrNotInstalled) {
			WriteError(w, http.StatusNotFound, CodeNotFound, err.Error(), nil)
			return
		}
		WriteError(w, http.StatusConflict, CodeConflict, err.Error(), nil)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
