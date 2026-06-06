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
