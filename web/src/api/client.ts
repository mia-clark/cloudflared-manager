import axios from 'axios';

// 从 localStorage 获取已保存的 API Token
export const getAPIToken = (): string => {
  return localStorage.getItem('frpsmgr_api_token') || '';
};

// 保存 API Token
export const setAPIToken = (token: string) => {
  localStorage.setItem('frpsmgr_api_token', token);
};

// 清除 API Token
export const clearAPIToken = () => {
  localStorage.removeItem('frpsmgr_api_token');
};

const client = axios.create({
  baseURL: '', // 使用相对路径以走 Vite proxy 代理或同域名部署
  timeout: 15000,
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
  (error) => {
    return Promise.reject(error);
  }
);

// 响应拦截器：统一处理 401 权限失效
client.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    if (error.response && error.response.status === 401) {
      // 排除验证 token 时的错误（以防死循环）
      if (!error.config.url?.includes('/api/v1/version') && !error.config.url?.includes('/api/v1/health')) {
        clearAPIToken();
        // 强制重定向至登录页
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default client;
