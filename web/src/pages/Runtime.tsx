import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Card, Row, Col, Select, Space, Typography, Statistic, Table, Tag,
  Button, Tooltip, Empty, Alert, Switch, theme as antdTheme, App,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ReloadOutlined,
  ArrowDownOutlined,
  ArrowUpOutlined,
  ApiOutlined,
  ClusterOutlined,
} from '@ant-design/icons';

import client from '../api/client';
import type {
  Snapshot,
  RuntimeOverview,
  RuntimeProxy,
  RuntimeProxyList,
  RuntimeClient,
} from '../api/types';

const { Title, Text } = Typography;

const REFRESH_MS = 5000;

// 人类可读字节格式化。
const formatBytes = (n?: number): string => {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  if (n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(2)} ${units[i]}`;
};

const Runtime: React.FC = () => {
  const { token } = antdTheme.useToken();
  const { message } = App.useApp();

  const [configs, setConfigs] = useState<Snapshot[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');

  const [overview, setOverview] = useState<RuntimeOverview | null>(null);
  const [proxies, setProxies] = useState<RuntimeProxy[]>([]);
  const [clients, setClients] = useState<RuntimeClient[]>([]);

  const [loading, setLoading] = useState<boolean>(false);
  // 该实例未运行（409）：不弹错误，转空态。
  const [notRunning, setNotRunning] = useState<boolean>(false);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);

  // 拉取配置列表，初始化选择器。
  const fetchConfigs = useCallback(async () => {
    try {
      const resp = await client.get('/api/v1/configs');
      const items: Snapshot[] = resp.data?.items || [];
      setConfigs(items);
      setSelectedId((prev) => {
        if (prev && items.some((c) => c.id === prev)) return prev;
        const firstRunning = items.find((c) => c.state === 'started');
        return firstRunning ? firstRunning.id : (items[0]?.id ?? '');
      });
    } catch {
      message.error('无法获取配置列表');
    }
  }, [message]);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  // 拉取选中实例的运行时数据。silent=true 用于定时刷新，不显示整体 loading。
  const loadRuntime = useCallback(
    async (id: string, silent = false) => {
      if (!id) return;
      if (!silent) setLoading(true);
      try {
        const [ovResp, pxResp, clResp] = await Promise.all([
          client.get(`/api/v1/runtime/${id}/overview`),
          client.get(`/api/v1/runtime/${id}/proxies`),
          client.get(`/api/v1/runtime/${id}/clients`),
        ]);
        setNotRunning(false);
        setOverview((ovResp.data as RuntimeOverview) || null);
        const list = pxResp.data as RuntimeProxyList | undefined;
        setProxies(Array.isArray(list?.proxies) ? list!.proxies : []);
        setClients(Array.isArray(clResp.data) ? (clResp.data as RuntimeClient[]) : []);
      } catch (err: any) {
        const status = err?.response?.status;
        if (status === 409) {
          // 实例未运行：优雅空态，不弹错误。
          setNotRunning(true);
          setOverview(null);
          setProxies([]);
          setClients([]);
        } else if (status === 404) {
          setNotRunning(false);
          setOverview(null);
          setProxies([]);
          setClients([]);
          if (!silent) message.error('该配置不存在');
        } else if (!silent) {
          message.error('获取运行时数据失败: ' + (err?.response?.data?.error?.message || err?.message || ''));
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [message]
  );

  // 选中实例变化时立即加载。
  useEffect(() => {
    if (selectedId) {
      loadRuntime(selectedId, false);
    } else {
      setOverview(null);
      setProxies([]);
      setClients([]);
      setNotRunning(false);
    }
  }, [selectedId, loadRuntime]);

  // 定时刷新（每 5s，silent 模式）。用 ref 规避闭包陷阱。
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      const id = selectedIdRef.current;
      if (id) loadRuntime(id, true);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, loadRuntime]);

  const proxyColumns: ColumnsType<RuntimeProxy> = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      render: (v: string) => <Text strong>{v}</Text>,
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      render: (v?: string) => (v ? <Tag color="blue">{v.toUpperCase()}</Tag> : '—'),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (v?: string) =>
        v ? (
          <Tag color={v === 'online' ? 'success' : 'default'}>{v}</Tag>
        ) : (
          '—'
        ),
    },
    {
      title: '当前连接',
      dataIndex: 'curConns',
      key: 'curConns',
      align: 'right',
      render: (v?: number) => v ?? 0,
    },
    {
      title: '今日入站',
      dataIndex: 'todayTrafficIn',
      key: 'todayTrafficIn',
      align: 'right',
      render: (v?: number) => formatBytes(v),
    },
    {
      title: '今日出站',
      dataIndex: 'todayTrafficOut',
      key: 'todayTrafficOut',
      align: 'right',
      render: (v?: number) => formatBytes(v),
    },
  ];

  const clientColumns: ColumnsType<RuntimeClient> = [
    {
      title: 'RunID',
      dataIndex: 'runID',
      key: 'runID',
      render: (v?: string) => (v ? <Text code style={{ fontSize: 12 }}>{v}</Text> : '—'),
    },
    {
      title: '地址',
      dataIndex: 'addr',
      key: 'addr',
      render: (v?: string) => v ?? '—',
    },
    {
      title: '版本',
      dataIndex: 'version',
      key: 'version',
      render: (v?: string) => (v ? <Tag>{v}</Tag> : '—'),
    },
    {
      title: '连接时间',
      dataIndex: 'connectAt',
      key: 'connectAt',
      render: (v?: string) => v ?? '—',
    },
  ];

  const selectOptions = configs.map((c) => ({
    value: c.id,
    label: (
      <Space size={6}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            display: 'inline-block',
            background:
              c.state === 'started'
                ? token.colorSuccess
                : c.state === 'starting' || c.state === 'stopping'
                ? token.colorWarning
                : token.colorTextDisabled,
          }}
        />
        <span>{c.name || c.id}</span>
        <Text type="secondary" style={{ fontSize: 12 }}>
          ({c.id})
        </Text>
      </Space>
    ),
  }));

  const proxyTypeCount = overview?.proxyTypeCount ?? {};
  const proxyTypeEntries = Object.entries(proxyTypeCount).filter(([, n]) => n > 0);

  return (
    <div style={{ height: '100%' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <Space size={12} align="center">
          <Title level={4} style={{ margin: 0 }}>
            运行时监控
          </Title>
          <Select
            style={{ minWidth: 280 }}
            placeholder="选择一个 FRPS 实例"
            value={selectedId || undefined}
            onChange={setSelectedId}
            options={selectOptions}
            notFoundContent={<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无配置" />}
          />
        </Space>
        <Space size={10} align="center">
          <Switch
            checked={autoRefresh}
            onChange={setAutoRefresh}
            checkedChildren="自动刷新"
            unCheckedChildren="已暂停"
          />
          <Tooltip title="立即刷新">
            <Button
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => selectedId && loadRuntime(selectedId, false)}
              disabled={!selectedId}
            />
          </Tooltip>
        </Space>
      </div>

      {!selectedId ? (
        <Card style={{ padding: '80px 0', borderRadius: 10 }}>
          <Empty description="请先在上方选择一个 FRPS 实例。" />
        </Card>
      ) : notRunning ? (
        <Card style={{ padding: '60px 0', borderRadius: 10 }}>
          <Empty description="该实例未运行，启动后可查看运行时数据。" />
        </Card>
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {/* 总览卡片 */}
          <Row gutter={[16, 16]}>
            <Col xs={12} sm={12} md={6}>
              <Card bordered={false} style={{ borderRadius: 10 }}>
                <Statistic
                  title="当前连接数"
                  value={overview?.curConns ?? 0}
                  prefix={<ApiOutlined />}
                />
              </Card>
            </Col>
            <Col xs={12} sm={12} md={6}>
              <Card bordered={false} style={{ borderRadius: 10 }}>
                <Statistic
                  title="在线客户端"
                  value={overview?.clientCounts ?? 0}
                  prefix={<ClusterOutlined />}
                />
              </Card>
            </Col>
            <Col xs={12} sm={12} md={6}>
              <Card bordered={false} style={{ borderRadius: 10 }}>
                <Statistic
                  title="累计入站流量"
                  value={formatBytes(overview?.totalTrafficIn)}
                  prefix={<ArrowDownOutlined style={{ color: token.colorSuccess }} />}
                />
              </Card>
            </Col>
            <Col xs={12} sm={12} md={6}>
              <Card bordered={false} style={{ borderRadius: 10 }}>
                <Statistic
                  title="累计出站流量"
                  value={formatBytes(overview?.totalTrafficOut)}
                  prefix={<ArrowUpOutlined style={{ color: token.colorWarning }} />}
                />
              </Card>
            </Col>
          </Row>

          {/* 代理类型分布 + 服务端信息 */}
          <Card
            title="服务端概览"
            bordered={false}
            style={{ borderRadius: 10 }}
            styles={{ body: { paddingTop: 12 } }}
          >
            <Space size={[8, 8]} wrap style={{ marginBottom: 12 }}>
              {proxyTypeEntries.length === 0 ? (
                <Text type="secondary">暂无活跃代理类型</Text>
              ) : (
                proxyTypeEntries.map(([type, count]) => (
                  <Tag key={type} color="geekblue" style={{ fontSize: 13, padding: '2px 10px' }}>
                    {type.toUpperCase()}: {count}
                  </Tag>
                ))
              )}
            </Space>
            <Row gutter={[16, 8]}>
              <Col xs={12} md={6}>
                <Text type="secondary">FRPS 版本</Text>
                <div><Text strong>{overview?.version ?? '—'}</Text></div>
              </Col>
              <Col xs={12} md={6}>
                <Text type="secondary">bindPort</Text>
                <div><Text strong>{overview?.bindPort ?? '—'}</Text></div>
              </Col>
              <Col xs={12} md={6}>
                <Text type="secondary">vhostHTTPPort</Text>
                <div><Text strong>{overview?.vhostHTTPPort ?? '—'}</Text></div>
              </Col>
              <Col xs={12} md={6}>
                <Text type="secondary">vhostHTTPSPort</Text>
                <div><Text strong>{overview?.vhostHTTPSPort ?? '—'}</Text></div>
              </Col>
            </Row>
          </Card>

          {/* 活跃客户端表格 */}
          <Card
            title={`活跃客户端 (${clients.length})`}
            bordered={false}
            style={{ borderRadius: 10 }}
          >
            <Table<RuntimeClient>
              size="small"
              rowKey={(r) => r.runID || r.addr || JSON.stringify(r)}
              columns={clientColumns}
              dataSource={clients}
              loading={loading}
              pagination={{ pageSize: 10, hideOnSinglePage: true }}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无在线客户端" /> }}
            />
          </Card>

          {/* 活跃代理表格 */}
          <Card
            title={`活跃代理 (${proxies.length})`}
            bordered={false}
            style={{ borderRadius: 10 }}
          >
            <Table<RuntimeProxy>
              size="small"
              rowKey={(r) => r.name}
              columns={proxyColumns}
              dataSource={proxies}
              loading={loading}
              pagination={{ pageSize: 10, hideOnSinglePage: true }}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无活跃代理" /> }}
            />
          </Card>

          <Alert
            type="info"
            showIcon
            banner
            message="运行时数据为 FRPS 服务端在客户端连接后产生的动态指标，每 5 秒自动刷新。"
          />
        </Space>
      )}
    </div>
  );
};

export default Runtime;
