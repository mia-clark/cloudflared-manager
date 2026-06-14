import { useCallback, useEffect, useState } from 'react';
import {
  Card,
  Space,
  Typography,
  Form,
  Switch,
  Select,
  InputNumber,
  Button,
  Descriptions,
  Tag,
  Alert,
  Divider,
  App,
} from 'antd';
import {
  CloudSyncOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';

import { autoUpdateApi } from '../api/client';
import type { AutoUpdateSettings, AutoUpdateStatus, AutoUpdateMode } from '../api/types';
import { useEventSubscription } from '../events/EventStreamContext';
import { fmtDateTime } from '../utils/time';

const { Title, Text } = Typography;

const MODE_LABEL: Record<AutoUpdateMode, string> = {
  full: '全自动（下载 + 激活 + 滚动重启）',
  download: '仅下载（备好新版，手动应用）',
  notify: '仅提示（只检查，不下载）',
};

// 运行状态 → 中文 + 颜色
const STATE_META: Record<string, { label: string; color: string }> = {
  idle: { label: '空闲', color: 'default' },
  checking: { label: '检查中', color: 'processing' },
  downloading: { label: '下载中', color: 'processing' },
  applying: { label: '激活中', color: 'processing' },
  restarting: { label: '重启实例中', color: 'processing' },
  rolling_back: { label: '回滚中', color: 'warning' },
};

const RESULT_META: Record<string, { label: string; color: string }> = {
  up_to_date: { label: '已是最新', color: 'success' },
  updated: { label: '已更新', color: 'success' },
  downloaded: { label: '已下载待应用', color: 'blue' },
  notified: { label: '发现新版', color: 'blue' },
  failed: { label: '更新失败', color: 'error' },
  rolled_back: { label: '已回滚', color: 'warning' },
  rolled_back_degraded: { label: '已回滚（部分实例未恢复）', color: 'error' },
};

function StateTag({ status }: { status: AutoUpdateStatus }) {
  if (status.in_progress || status.state !== 'idle') {
    const m = STATE_META[status.state] || { label: status.state, color: 'processing' };
    return <Tag color={m.color}>{m.label}</Tag>;
  }
  if (status.last_result) {
    const m = RESULT_META[status.last_result] || { label: status.last_result, color: 'default' };
    return <Tag color={m.color}>{m.label}</Tag>;
  }
  return <Tag>空闲</Tag>;
}

const AutoUpdateCard: React.FC = () => {
  const { message } = App.useApp();
  const [form] = Form.useForm<AutoUpdateSettings>();

  const [status, setStatus] = useState<AutoUpdateStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await autoUpdateApi.get();
      form.setFieldsValue(resp.data.settings);
      setStatus(resp.data.status);
      setUnavailable(false);
    } catch (err: unknown) {
      const e = err as { response?: { status?: number } };
      if (e.response?.status === 503 || e.response?.status === 404) {
        setUnavailable(true);
      }
    } finally {
      setLoading(false);
    }
  }, [form]);

  useEffect(() => {
    load();
  }, [load]);

  // 实时进度：任何 binary.update 事件都刷新状态。
  useEventSubscription(['binary.update'], () => {
    autoUpdateApi
      .get()
      .then((r) => setStatus(r.data.status))
      .catch(() => {});
  });

  const onSave = async (vals: AutoUpdateSettings) => {
    setSaving(true);
    try {
      const resp = await autoUpdateApi.update(vals);
      form.setFieldsValue(resp.data.settings);
      setStatus(resp.data.status);
      message.success('自动更新设置已保存，即时生效');
    } catch {
      message.error('保存失败，请检查登录令牌与网络');
    } finally {
      setSaving(false);
    }
  };

  const trigger = async (opts: { apply?: boolean; force?: boolean }, label: string) => {
    setRunning(true);
    try {
      await autoUpdateApi.run(opts);
      message.success(`${label}已开始，进度见下方状态`);
      // 立即拉一次最新状态（事件也会推）
      setTimeout(() => autoUpdateApi.get().then((r) => setStatus(r.data.status)).catch(() => {}), 300);
    } catch (err: unknown) {
      const e = err as { response?: { status?: number; data?: { error?: { message?: string } } } };
      if (e.response?.status === 409) {
        message.warning('已有更新任务在进行中，请稍候');
      } else {
        message.error(`${label}失败：` + (e.response?.data?.error?.message || '未知错误'));
      }
    } finally {
      setRunning(false);
    }
  };

  if (unavailable) {
    return (
      <Card styles={{ body: { padding: 18 } }} style={{ borderRadius: 10 }}>
        <Space direction="vertical" size={8}>
          <Title level={5} style={{ margin: 0 }}>
            <CloudSyncOutlined /> cloudflared 二进制自动更新
          </Title>
          <Alert
            type="warning"
            showIcon
            message="当前后端不支持二进制自动更新 API"
            description="请升级 cfdmgrd 守护进程后重试。"
          />
        </Space>
      </Card>
    );
  }

  return (
    <Card
      styles={{ body: { padding: 18 } }}
      style={{ borderRadius: 10 }}
      title={
        <Space>
          <CloudSyncOutlined />
          <span>cloudflared 二进制自动更新</span>
          {status && <StateTag status={status} />}
        </Space>
      }
      extra={
        <Space>
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={load}>
            刷新
          </Button>
        </Space>
      }
    >
      <Form<AutoUpdateSettings>
        form={form}
        layout="horizontal"
        labelCol={{ span: 9 }}
        wrapperCol={{ span: 15 }}
        onFinish={onSave}
        style={{ maxWidth: 560 }}
        initialValues={{
          enabled: true,
          mode: 'full',
          interval_hours: 24,
          include_prerelease: false,
          auto_rollback: true,
          keep_versions: 3,
          health_grace_seconds: 8,
        }}
      >
        <Form.Item label="自动更新" name="enabled" valuePropName="checked" extra="关闭后不再定时检查；手动「立即检查/更新」仍可用。">
          <Switch checkedChildren="开" unCheckedChildren="关" />
        </Form.Item>
        <Form.Item label="更新模式" name="mode">
          <Select<AutoUpdateMode>
            options={(['full', 'download', 'notify'] as AutoUpdateMode[]).map((m) => ({
              value: m,
              label: MODE_LABEL[m],
            }))}
          />
        </Form.Item>
        <Form.Item label="检查间隔（小时）" name="interval_hours">
          <InputNumber min={1} max={720} style={{ width: 140 }} />
        </Form.Item>
        <Form.Item label="保留版本数" name="keep_versions" extra="0 = 不自动清理旧版本。激活中 / 被实例钉用的版本永不删除。">
          <InputNumber min={0} max={50} style={{ width: 140 }} />
        </Form.Item>
        <Form.Item label="重启健康观察（秒）" name="health_grace_seconds" extra="重启实例后观察这段时间确认其稳定运行。">
          <InputNumber min={1} max={120} style={{ width: 140 }} />
        </Form.Item>
        <Form.Item label="包含预发布版" name="include_prerelease" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item label="失败自动回滚" name="auto_rollback" valuePropName="checked" extra="新版导致实例起不来时，自动回退到上一个可用版本并恢复实例。">
          <Switch />
        </Form.Item>
        <Form.Item wrapperCol={{ offset: 9, span: 15 }} style={{ marginBottom: 0 }}>
          <Button type="primary" htmlType="submit" loading={saving}>
            保存设置
          </Button>
        </Form.Item>
      </Form>

      <Divider style={{ margin: '16px 0' }} />

      <Descriptions column={1} size="small" labelStyle={{ width: 130 }}>
        <Descriptions.Item label="当前使用版本">
          <Text code>{status?.active_version || '—'}</Text>
        </Descriptions.Item>
        <Descriptions.Item label="最新已知版本">
          <Text code>{status?.latest_known || '—'}</Text>
        </Descriptions.Item>
        {status?.pending_version ? (
          <Descriptions.Item label="已下载待应用">
            <Text code>{status.pending_version}</Text>
          </Descriptions.Item>
        ) : null}
        <Descriptions.Item label="上次检查">
          {status?.last_check_at ? fmtDateTime(status.last_check_at) : '—'}
        </Descriptions.Item>
        {status?.last_error ? (
          <Descriptions.Item label="上次错误">
            <Text type="danger" style={{ fontSize: 12 }}>{status.last_error}</Text>
          </Descriptions.Item>
        ) : null}
      </Descriptions>

      <Space style={{ marginTop: 12 }} wrap>
        <Button icon={<ReloadOutlined />} loading={running} onClick={() => trigger({}, '检查更新')}>
          立即检查
        </Button>
        <Button
          type="primary"
          icon={<ThunderboltOutlined />}
          loading={running}
          onClick={() => trigger({ apply: true }, '更新到最新')}
        >
          更新到最新并应用
        </Button>
      </Space>
    </Card>
  );
};

export default AutoUpdateCard;
