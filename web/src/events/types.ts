// 与后端 internal/eventbus/types.go 对齐
export type EventType =
  | 'instance.state'
  | 'instance.error'
  | 'proxy.status'
  | 'proxy.connections'
  | 'config.changed'
  | 'config.deleted'
  | 'log.line'
  | 'alert'
  | 'binary.update';

export interface BusEvent<T = unknown> {
  seq: number;
  type: EventType;
  config_id?: string;
  ts: string;
  data?: T;
}

export interface InstanceStateData {
  state: string;
  prev_state?: string;
}

export interface InstanceErrorData {
  message: string;
}

export interface ProxyStatusData {
  name: string;
  type: string;
  status: string;
  remote_addr?: string;
  error?: string;
}

export interface ProxyConnectionsData {
  name: string;
  type: string;
  cur_conns: number;
}

export interface LogLineData {
  line: string;
}

// alert 事件载荷（对应 sampler.publishAlert 的 map 负载，snake_case）
export interface AlertData {
  rule_id: string;
  rule_name: string;
  target: string;
  state: 'firing' | 'resolved';
  value: number;
  threshold: number;
  metric: string;
  fired_at: number;
  resolved_at: number;
}

// binary.update 事件载荷（对应 eventbus.BinaryUpdateData，snake_case）。
// phase: checking|up_to_date|available|downloading|downloaded|applying|
//        restarting|done|rolled_back|error
export interface BinaryUpdateData {
  phase: string;
  version?: string;
  from?: string;
  to?: string;
  instance_id?: string;
  message?: string;
  error?: string;
}

export type ConnState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';
