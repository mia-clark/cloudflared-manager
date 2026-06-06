package metrics

// AlertRule is a user-defined threshold rule evaluated by the sampler loop.
type AlertRule struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Enabled    bool    `json:"enabled"`
	InstID     string  `json:"inst_id"`     // target config instance, or "*" for all
	Metric     string  `json:"metric"`      // conns | traffic_in_rate | traffic_out_rate
	Op         string  `json:"op"`          // ">" | ">=" | "<" | "<="
	Threshold  float64 `json:"threshold"`   // compared against the metric value
	ForSeconds int     `json:"for_seconds"` // must hold this long before firing (debounce)
	Target     string  `json:"target"`      // proxy name, or "" / "*" for server scope
	Webhook    string  `json:"webhook"`     // optional POST URL on fire/resolve
}

// AlertEvent records a firing/resolved transition of a rule.
type AlertEvent struct {
	ID         string  `json:"id"`
	RuleID     string  `json:"rule_id"`
	InstID     string  `json:"inst_id"`
	Target     string  `json:"target"`
	FiredAt    int64   `json:"fired_at"`
	ResolvedAt int64   `json:"resolved_at"` // 0 while still firing
	Value      float64 `json:"value"`
	State      string  `json:"state"` // firing | resolved
}

// ListRules returns all alert rules.
func (s *Store) ListRules() ([]AlertRule, error) {
	rows, err := s.db.Query(`SELECT id,name,enabled,inst_id,metric,op,threshold,for_seconds,target,webhook FROM alert_rules ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]AlertRule, 0)
	for rows.Next() {
		var r AlertRule
		var enabled int
		if err := rows.Scan(&r.ID, &r.Name, &enabled, &r.InstID, &r.Metric, &r.Op, &r.Threshold, &r.ForSeconds, &r.Target, &r.Webhook); err != nil {
			return nil, err
		}
		r.Enabled = enabled != 0
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetRule returns one rule by id; ok=false if absent.
func (s *Store) GetRule(id string) (AlertRule, bool, error) {
	var r AlertRule
	var enabled int
	err := s.db.QueryRow(`SELECT id,name,enabled,inst_id,metric,op,threshold,for_seconds,target,webhook FROM alert_rules WHERE id=?`, id).
		Scan(&r.ID, &r.Name, &enabled, &r.InstID, &r.Metric, &r.Op, &r.Threshold, &r.ForSeconds, &r.Target, &r.Webhook)
	if err != nil {
		if err.Error() == "sql: no rows in result set" {
			return AlertRule{}, false, nil
		}
		return AlertRule{}, false, err
	}
	r.Enabled = enabled != 0
	return r, true, nil
}

// UpsertRule inserts or replaces a rule.
func (s *Store) UpsertRule(r AlertRule) error {
	enabled := 0
	if r.Enabled {
		enabled = 1
	}
	_, err := s.db.Exec(
		`INSERT INTO alert_rules(id,name,enabled,inst_id,metric,op,threshold,for_seconds,target,webhook)
		 VALUES(?,?,?,?,?,?,?,?,?,?)
		 ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,inst_id=excluded.inst_id,
		   metric=excluded.metric,op=excluded.op,threshold=excluded.threshold,for_seconds=excluded.for_seconds,
		   target=excluded.target,webhook=excluded.webhook`,
		r.ID, r.Name, enabled, r.InstID, r.Metric, r.Op, r.Threshold, r.ForSeconds, r.Target, r.Webhook)
	return err
}

// DeleteRule removes a rule by id.
func (s *Store) DeleteRule(id string) error {
	_, err := s.db.Exec(`DELETE FROM alert_rules WHERE id=?`, id)
	return err
}

// InsertEvent records a new alert event.
func (s *Store) InsertEvent(e AlertEvent) error {
	_, err := s.db.Exec(
		`INSERT INTO alert_events(id,rule_id,inst_id,target,fired_at,resolved_at,value,state) VALUES(?,?,?,?,?,?,?,?)`,
		e.ID, e.RuleID, e.InstID, e.Target, e.FiredAt, e.ResolvedAt, e.Value, e.State)
	return err
}

// ResolveEvent marks the latest firing event of a rule as resolved.
func (s *Store) ResolveEvent(ruleID string, resolvedAt int64) error {
	_, err := s.db.Exec(
		`UPDATE alert_events SET state='resolved', resolved_at=?
		   WHERE rule_id=? AND state='firing'`,
		resolvedAt, ruleID)
	return err
}

// ListEvents returns alert events optionally filtered by state and time range
// (from/to unix seconds; 0 means unbounded).
func (s *Store) ListEvents(state string, from, to int64) ([]AlertEvent, error) {
	q := `SELECT id,rule_id,inst_id,target,fired_at,resolved_at,value,state FROM alert_events WHERE 1=1`
	args := []any{}
	if state != "" {
		q += ` AND state=?`
		args = append(args, state)
	}
	if from > 0 {
		q += ` AND fired_at>=?`
		args = append(args, from)
	}
	if to > 0 {
		q += ` AND fired_at<=?`
		args = append(args, to)
	}
	q += ` ORDER BY fired_at DESC LIMIT 500`
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]AlertEvent, 0)
	for rows.Next() {
		var e AlertEvent
		if err := rows.Scan(&e.ID, &e.RuleID, &e.InstID, &e.Target, &e.FiredAt, &e.ResolvedAt, &e.Value, &e.State); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
