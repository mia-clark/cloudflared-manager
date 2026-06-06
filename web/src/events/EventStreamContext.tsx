import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getAPIToken } from '../api/client';
import type { BusEvent, ConnState, EventType } from './types';

type Listener = (e: BusEvent) => void;

interface EventStreamContextValue {
  state: ConnState;
  lastSeq: number;
  lastEvent: BusEvent | null;
  // 订阅一类或多类事件。返回取消订阅函数。types 为 null/undefined 时订阅全部。
  subscribe: (types: EventType[] | null | undefined, fn: Listener) => () => void;
}

const Ctx = createContext<EventStreamContextValue | null>(null);

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 15_000;

function buildWsUrl(sinceSeq: number): string {
  const token = getAPIToken();
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams();
  if (token) params.set('token', token);
  if (sinceSeq > 0) params.set('since', String(sinceSeq));
  return `${proto}//${window.location.host}/api/v1/events?${params.toString()}`;
}

export function EventStreamProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConnState>('idle');
  const [lastSeq, setLastSeq] = useState<number>(0);
  const [lastEvent, setLastEvent] = useState<BusEvent | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const seqRef = useRef<number>(0);
  const retriesRef = useRef<number>(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const stoppedRef = useRef<boolean>(false);
  // listeners: type -> Set<fn>，'*' 代表订阅全部
  const listenersRef = useRef<Map<EventType | '*', Set<Listener>>>(new Map());

  const dispatch = useCallback((evt: BusEvent) => {
    const all = listenersRef.current.get('*');
    if (all) for (const fn of all) fn(evt);
    const targeted = listenersRef.current.get(evt.type);
    if (targeted) for (const fn of targeted) fn(evt);
  }, []);

  const connect = useCallback(() => {
    if (stoppedRef.current) return;
    const token = getAPIToken();
    if (!token) {
      // 没有 token，等待登录后再连
      setState('idle');
      return;
    }
    setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(buildWsUrl(seqRef.current));
    } catch {
      setState('error');
      scheduleReconnect();
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      retriesRef.current = 0;
      setState('open');
    };
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data as string) as BusEvent;
        if (typeof data.seq === 'number' && data.seq > seqRef.current) {
          seqRef.current = data.seq;
          setLastSeq(data.seq);
        }
        setLastEvent(data);
        dispatch(data);
      } catch {
        // 忽略非法帧
      }
    };
    ws.onerror = () => {
      setState('error');
    };
    ws.onclose = () => {
      wsRef.current = null;
      setState('closed');
      scheduleReconnect();
    };
  }, [dispatch]);

  const scheduleReconnect = useCallback(() => {
    if (stoppedRef.current) return;
    if (reconnectTimerRef.current != null) return;
    const attempt = retriesRef.current++;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      connect();
    }, delay);
  }, [connect]);

  useEffect(() => {
    stoppedRef.current = false;
    connect();
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'frpsmgr_api_token') {
        // token 变化时重连
        if (wsRef.current) wsRef.current.close();
        retriesRef.current = 0;
        connect();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      stoppedRef.current = true;
      window.removeEventListener('storage', onStorage);
      if (reconnectTimerRef.current != null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  const subscribe = useCallback<EventStreamContextValue['subscribe']>((types, fn) => {
    const keys: (EventType | '*')[] = !types || types.length === 0 ? ['*'] : types;
    for (const k of keys) {
      let set = listenersRef.current.get(k);
      if (!set) {
        set = new Set();
        listenersRef.current.set(k, set);
      }
      set.add(fn);
    }
    return () => {
      for (const k of keys) {
        const set = listenersRef.current.get(k);
        if (set) {
          set.delete(fn);
          if (set.size === 0) listenersRef.current.delete(k);
        }
      }
    };
  }, []);

  const value = useMemo<EventStreamContextValue>(
    () => ({ state, lastSeq, lastEvent, subscribe }),
    [state, lastSeq, lastEvent, subscribe]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEventStream() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useEventStream must be used within EventStreamProvider');
  return ctx;
}

// 便利 hook：订阅一类或多类事件并触发回调
export function useEventSubscription(types: EventType[] | null | undefined, fn: Listener) {
  const { subscribe } = useEventStream();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    return subscribe(types, (e) => fnRef.current(e));
    // types 用 JSON 序列化做依赖比较，避免引用变化导致频繁退订
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, JSON.stringify(types)]);
}
