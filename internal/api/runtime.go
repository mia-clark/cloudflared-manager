package api

import (
	"net/http"

	"github.com/mia-clark/cloudflared-manager/internal/manager"
)

// RuntimeHandler serves the read-only /api/v1/runtime/{id}/* endpoints.
//
// PR-04 transitional stub: the frps loopback webServer model has been
// removed along with the re-exec-self worker. The cloudflared
// --metrics Prometheus scraper that replaces it lands in PR-07.
// Until then, all runtime endpoints return 410 Gone so callers know
// the data is temporarily unavailable rather than the instance being
// not found.
type RuntimeHandler struct {
	m *manager.Manager
}

// NewRuntimeHandler builds a RuntimeHandler.
func NewRuntimeHandler(m *manager.Manager) *RuntimeHandler {
	return &RuntimeHandler{m: m}
}

// gone writes a 410 Gone response with a clear PR reference.
func gone(w http.ResponseWriter) {
	WriteError(w, http.StatusGone, CodeInvalidState,
		"runtime metrics unavailable in this build; will be restored in PR-07 (cloudflared --metrics scraper)", nil)
}

// Overview is a stub pending PR-07.
func (h *RuntimeHandler) Overview(w http.ResponseWriter, r *http.Request) {
	gone(w)
}

// Clients is a stub pending PR-07.
func (h *RuntimeHandler) Clients(w http.ResponseWriter, r *http.Request) {
	gone(w)
}

// ProxyByName is a stub pending PR-07.
func (h *RuntimeHandler) ProxyByName(w http.ResponseWriter, r *http.Request) {
	gone(w)
}

// Proxies is a stub pending PR-07.
func (h *RuntimeHandler) Proxies(w http.ResponseWriter, r *http.Request) {
	gone(w)
}
