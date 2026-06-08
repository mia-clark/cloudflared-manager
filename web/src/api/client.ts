import axios from 'axios';
import type {
  ConfigList,
  ConfigEnvelope,
  ValidateResp,
  BinaryList,
  AvailableList,
  BinaryItem,
  TrafficSeries,
} from './types';

// localStorage key
const TOKEN_KEY = 'cfdmgr_api_token';

export const getAPIToken = (): string => {
  return localStorage.getItem(TOKEN_KEY) || '';
};

export const setAPIToken = (token: string) => {
  localStorage.setItem(TOKEN_KEY, token);
};

export const clearAPIToken = () => {
  localStorage.removeItem(TOKEN_KEY);
};

const client = axios.create({
  baseURL: '',
  timeout: 30000,
});

// 请求拦截器：自动注入 Bearer Token
client.interceptors.request.use(
  (config) => {
    const token = getAPIToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// 响应拦截器：统一处理 401
client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response && error.response.status === 401) {
      if (
        !error.config.url?.includes('/api/v1/version') &&
        !error.config.url?.includes('/api/v1/health')
      ) {
        clearAPIToken();
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default client;

// ── Configs API ──────────────────────────────────────────────────────────────

export const configsApi = {
  list: () => client.get<ConfigList>('/api/v1/configs'),
  get: (id: string) => client.get<ConfigEnvelope>(`/api/v1/configs/${id}`),
  create: (payload: object) => client.post('/api/v1/configs', payload),
  update: (id: string, payload: object) => client.put(`/api/v1/configs/${id}`, payload),
  delete: (id: string) => client.delete(`/api/v1/configs/${id}`),
  start: (id: string) => client.post(`/api/v1/configs/${id}/start`),
  stop: (id: string) => client.post(`/api/v1/configs/${id}/stop`),
  reload: (id: string) => client.post(`/api/v1/configs/${id}/reload`),
  duplicate: (id: string, newId: string) =>
    client.post(`/api/v1/configs/${id}/duplicate`, { new_id: newId }),
  status: (id: string) => client.get(`/api/v1/configs/${id}/status`),
};

// ── Binaries API ─────────────────────────────────────────────────────────────

export const binariesApi = {
  list: () => client.get<BinaryList>('/api/v1/binaries'),
  available: () => client.get<AvailableList>('/api/v1/binaries/available'),
  install: (version: string) =>
    client.post<BinaryItem>('/api/v1/binaries/install', { version }),
  // 后端路由是 POST /binaries/{version}/activate —— version 在路径里，不在 body。
  activate: (version: string) =>
    client.post(`/api/v1/binaries/${encodeURIComponent(version)}/activate`),
  delete: (version: string) => client.delete(`/api/v1/binaries/${encodeURIComponent(version)}`),
};

// ── Validate API ─────────────────────────────────────────────────────────────
export const validateApi = {
  validate: (content: string) =>
    client.post<ValidateResp>('/api/v1/validate', content, {
      headers: { 'Content-Type': 'text/plain' },
    }),
};

// ── Metrics / Traffic API ─────────────────────────────────────────────────────
// 历史流量曲线。注意 to 必填（unix 秒），缺省后端 400。字段语义（非字节）：
//   server scope     → in=请求数增量, out=错误数增量, conns=HA 连接数
//   edge_conn scope  → in=smoothed_rtt, out=lost_packets（key=conn_index 0..3）
export const metricsApi = {
  traffic: (
    id: string,
    params: { scope?: string; key?: string; from?: number; to: number; step?: number }
  ) => client.get<TrafficSeries>(`/api/v1/metrics/${encodeURIComponent(id)}/traffic`, { params }),
};
