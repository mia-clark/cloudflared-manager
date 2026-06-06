import { Dropdown, Button, Tooltip } from 'antd';
import { SunOutlined, MoonOutlined, DesktopOutlined } from '@ant-design/icons';
import { useTheme, type ThemeMode } from './ThemeContext';

const labelMap: Record<ThemeMode, string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
};

export default function ThemeSwitcher() {
  const { mode, setMode, resolved } = useTheme();

  return (
    <Dropdown
      trigger={['click']}
      menu={{
        selectedKeys: [mode],
        items: [
          { key: 'light', icon: <SunOutlined />, label: '浅色' },
          { key: 'dark', icon: <MoonOutlined />, label: '深色' },
          { key: 'system', icon: <DesktopOutlined />, label: '跟随系统' },
        ],
        onClick: ({ key }) => setMode(key as ThemeMode),
      }}
    >
      <Tooltip title={`主题：${labelMap[mode]}`} placement="bottom">
        <Button
          type="text"
          icon={resolved === 'dark' ? <MoonOutlined /> : <SunOutlined />}
          aria-label="切换主题"
        />
      </Tooltip>
    </Dropdown>
  );
}
