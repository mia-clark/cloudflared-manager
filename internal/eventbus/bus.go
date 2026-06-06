package eventbus

import (
	"sync"
	"sync/atomic"
	"time"
)

// Filter describes which events a subscriber wants to receive. A nil
// Filter accepts everything; a non-empty Types slice limits delivery to
// those types; a non-empty ConfigIDs slice limits delivery to those
// configs.
type Filter struct {
	Types     []EventType
	ConfigIDs []string
}

func (f *Filter) accepts(e Event) bool {
	if f == nil {
		return true
	}
	if len(f.Types) > 0 {
		ok := false
		for _, t := range f.Types {
			if t == e.Type {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
	}
	if len(f.ConfigIDs) > 0 {
		ok := false
		for _, c := range f.ConfigIDs {
			if c == e.ConfigID {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
	}
	return true
}

// Subscription is a handle returned by Subscribe.
type Subscription struct {
	id     uint64
	ch     chan Event
	bus    *Bus
	filter atomic.Pointer[Filter]
}

// C returns the channel events are delivered on. The channel is closed
// when Unsubscribe is called or when the bus is stopped.
func (s *Subscription) C() <-chan Event { return s.ch }

// SetFilter updates the subscription's filter atomically. Pass nil to
// receive everything.
func (s *Subscription) SetFilter(f *Filter) { s.filter.Store(f) }

// Unsubscribe drops the subscription and closes its channel.
func (s *Subscription) Unsubscribe() { s.bus.remove(s.id) }

// Bus is an in-process pub/sub hub. Publishers must not block; slow
// subscribers drop events.
type Bus struct {
	mu          sync.RWMutex
	subs        map[uint64]*Subscription
	nextSubID   uint64
	seq         atomic.Uint64
	ringMu      sync.RWMutex
	ring        []Event
	ringCap     int
	defaultDrop atomic.Uint64
}

// New constructs a Bus with the given recent-events ring buffer capacity.
func New(ringCap int) *Bus {
	if ringCap <= 0 {
		ringCap = 1024
	}
	return &Bus{
		subs:    make(map[uint64]*Subscription),
		ring:    make([]Event, 0, ringCap),
		ringCap: ringCap,
	}
}

// Publish fans an event out to every matching subscriber.
func (b *Bus) Publish(t EventType, configID string, data any) {
	e := Event{
		Seq:      b.seq.Add(1),
		Type:     t,
		ConfigID: configID,
		TS:       time.Now().UTC(),
		Data:     data,
	}
	b.appendRing(e)

	b.mu.RLock()
	for _, s := range b.subs {
		f := s.filter.Load()
		if !f.accepts(e) {
			continue
		}
		select {
		case s.ch <- e:
		default:
			b.defaultDrop.Add(1)
		}
	}
	b.mu.RUnlock()
}

func (b *Bus) appendRing(e Event) {
	b.ringMu.Lock()
	if len(b.ring) < b.ringCap {
		b.ring = append(b.ring, e)
	} else {
		copy(b.ring, b.ring[1:])
		b.ring[len(b.ring)-1] = e
	}
	b.ringMu.Unlock()
}

// Subscribe registers a new subscriber. bufSize is the per-subscriber
// channel capacity; events delivered while the buffer is full are
// dropped.
func (b *Bus) Subscribe(filter *Filter, bufSize int) *Subscription {
	if bufSize <= 0 {
		bufSize = 64
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.nextSubID++
	s := &Subscription{
		id:  b.nextSubID,
		ch:  make(chan Event, bufSize),
		bus: b,
	}
	s.filter.Store(filter)
	b.subs[s.id] = s
	return s
}

func (b *Bus) remove(id uint64) {
	b.mu.Lock()
	if s, ok := b.subs[id]; ok {
		delete(b.subs, id)
		close(s.ch)
	}
	b.mu.Unlock()
}

// Since returns recent events whose Seq is greater than since.
func (b *Bus) Since(since uint64) []Event {
	b.ringMu.RLock()
	out := make([]Event, 0, len(b.ring))
	for _, e := range b.ring {
		if e.Seq > since {
			out = append(out, e)
		}
	}
	b.ringMu.RUnlock()
	return out
}

// Stop closes every subscription channel.
func (b *Bus) Stop() {
	b.mu.Lock()
	for id, s := range b.subs {
		delete(b.subs, id)
		close(s.ch)
	}
	b.mu.Unlock()
}
