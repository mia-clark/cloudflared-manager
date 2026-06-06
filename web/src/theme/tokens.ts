import type { ThemeConfig } from 'antd';
import { theme as antdTheme } from 'antd';

const sharedToken = {
  borderRadius: 6,
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  fontSize: 14,
  wireframe: false,
};

export const lightTheme: ThemeConfig = {
  algorithm: antdTheme.defaultAlgorithm,
  token: {
    ...sharedToken,
    colorPrimary: '#1677ff',
    colorBgLayout: '#f5f7fa',
    colorBgContainer: '#ffffff',
    colorBorder: '#e6e8eb',
    colorBorderSecondary: '#f0f2f5',
  },
  components: {
    Layout: {
      siderBg: '#001529',
      headerBg: '#ffffff',
      bodyBg: '#f5f7fa',
      headerHeight: 56,
    },
    Menu: {
      darkItemBg: '#001529',
      darkSubMenuItemBg: '#000c17',
      darkItemSelectedBg: '#1677ff',
    },
    Card: {
      boxShadowTertiary: '0 1px 2px rgba(0,0,0,0.04)',
    },
  },
};

export const darkTheme: ThemeConfig = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    ...sharedToken,
    colorPrimary: '#1668dc',
    colorBgLayout: '#0a0a0a',
    colorBgContainer: '#141414',
    colorBorder: '#303030',
    colorBorderSecondary: '#1f1f1f',
  },
  components: {
    Layout: {
      siderBg: '#0c0c10',
      headerBg: '#141414',
      bodyBg: '#0a0a0a',
      headerHeight: 56,
    },
    Menu: {
      darkItemBg: '#0c0c10',
      darkSubMenuItemBg: '#08080a',
      darkItemSelectedBg: '#1668dc',
    },
  },
};
