// 与后端 internal/eventbus/types.go 对齐
export type EventType =
  | 'instance.state'
  | 'instance.error'
  | 'proxy.status'
  | 'proxy.connections'
  | 'config.changed'
  | 'config.deleted'
  | 'log.line';

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

export type ConnState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';
