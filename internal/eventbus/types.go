package eventbus

import "time"

// EventType is a short stable identifier for each event variant.
type EventType string

const (
	TypeInstanceState    EventType = "instance.state"
	TypeInstanceError    EventType = "instance.error"
	TypeProxyStatus      EventType = "proxy.status"
	TypeProxyConnections EventType = "proxy.connections"
	TypeConfigChanged    EventType = "config.changed"
	TypeConfigDeleted    EventType = "config.deleted"
	TypeLogLine          EventType = "log.line"
	TypeAlert            EventType = "alert"
	// TypeBinaryUpdate carries cloudflared binary auto-update progress.
	// A single event type whose Data.Phase distinguishes the step, so the
	// UI can subscribe to one channel and render the whole pipeline.
	TypeBinaryUpdate EventType = "binary.update"
)

// Event is a single message published on the bus. Data is the type-
// specific payload; subscribers may inspect Type to decide how to
// decode it.
type Event struct {
	Seq      uint64    `json:"seq"`
	Type     EventType `json:"type"`
	ConfigID string    `json:"config_id,omitempty"`
	TS       time.Time `json:"ts"`
	Data     any       `json:"data,omitempty"`
}

// InstanceStateData is the payload for TypeInstanceState.
type InstanceStateData struct {
	State     string `json:"state"`
	PrevState string `json:"prev_state,omitempty"`
}

// InstanceErrorData is the payload for TypeInstanceError.
type InstanceErrorData struct {
	Message string `json:"message"`
}

// ProxyStatusData is the payload for TypeProxyStatus.
type ProxyStatusData struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Status     string `json:"status"`
	RemoteAddr string `json:"remote_addr,omitempty"`
	Error      string `json:"error,omitempty"`
}

// ProxyConnectionsData is the payload for TypeProxyConnections.
type ProxyConnectionsData struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	CurConns int    `json:"cur_conns"`
}

// LogLineData is the payload for TypeLogLine.
type LogLineData struct {
	Line string `json:"line"`
}

// BinaryUpdateData is the payload for TypeBinaryUpdate. Phase names the
// pipeline step: checking | up_to_date | available | downloading |
// downloaded | applying | restarting | done | rolled_back | error.
// The optional fields carry context relevant to that phase only.
type BinaryUpdateData struct {
	Phase      string `json:"phase"`
	Version    string `json:"version,omitempty"`     // the target/installed version
	From       string `json:"from,omitempty"`        // previous active version (apply/rollback)
	To         string `json:"to,omitempty"`          // new active version (apply)
	InstanceID string `json:"instance_id,omitempty"` // during restarting/rolled_back
	Message    string `json:"message,omitempty"`
	Error      string `json:"error,omitempty"`
}
