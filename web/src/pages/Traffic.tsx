import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Card,
  Row,
  Col,
  Typography,
  Space,
  Select,
  Segmented,
  Button,
  Statistic,
  Empty,
  Skeleton,
  Alert,
  Tag,
  theme as antdTheme,
} from 'antd';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip as RTooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import {
  LineChartOutlined,
  ReloadOutlined,
  ApiOutlined,
  WarningOutlined,
  PercentageOutlined,
  ClusterOutlined,
} from '@ant-design/icons';
import { isAxiosError } from 'axios';
import { configsApi, metricsApi } from '../api/client';
import type { Snapshot } from '../api/types';
import { fmtHourMinute, fmtTime } from '../utils/time';

const { Title, Text } = Typography;

// 时间范围预设 → 自适应下采样 step（控制点数），数据默认保留 7 天故上限 7d。
const RANGES = [
  { key: '1h', label: '近 1 小时', sec: 3600, step: 30 },
  { key: '6h', label: '近 6 小时', sec: 21_600, step: 120 },
  { key: '24h', label: '近 24 小时', sec: 86_400, step: 300 },
  { key: '7d', label: '近 7 天', sec: 604_800, step: 3600 },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];

const REFRESH_MS = 30_000;

const STATE_LABEL: Record<Snapshot['state'], string> = {
  stopped: '已停止',
  starting: '启动中',
  started: '运行中',
  stopping: '停止中',
};

interface ChartRow {
  t: number; // 毫秒，X 轴
  reqRate: number; // 请求/秒
  errRate: number; // 错误/秒
  errPct: number; // 错误率 %
  conns: number; // HA 连接数
}

function fmtNum(n: number): string {
  if (!isFinite(n)) return '0';
  return n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2);
}

const TrafficPage = () => {
  const { token } = antdTheme.useToken();
  const [instances, setInstances] = useState<Snapshot[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [range, setRange] = useState<RangeKey>('1h');
  const [rows, setRows] = useState<ChartRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [instLoading, setInstLoading] = useState(true);
  const [disabled, setDisabled] = useState(false); // 后端 metrics store 503
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const cfg = RANGES.find((r) => r.key === range) ?? RANGES[0];

  // 实例列表（用于下拉）
  useEffect(() => {
    let stop = false;
    configsApi
      .list()
      .then((r) => {
        if (stop) return;
        const items = r.data.items ?? [];
        setInstances(items);
        setSelectedId((cur) => cur ?? items.find((i) => i.state === 'started')?.id ?? items[0]?.id);
      })
      .catch(() => {})
      .finally(() => {
        if (!stop) setInstLoading(false);
      });
    return () => {
      stop = true;
    };
  }, []);

  const load = useCallback(async (id: string, step: number, sec: number) => {
    const to = Math.floor(Date.now() / 1000);
    const from = to - sec;
    try {
      const resp = await metricsApi.traffic(id, { scope: 'server', from, to, step });
      const pts = resp.data.points ?? [];
      setRows(
        pts.map((p) => ({
          t: p.ts * 1000,
          reqRate: step > 0 ? p.in / step : 0,
          errRate: step > 0 ? p.out / step : 0,
          errPct: p.in > 0 ? (p.out / p.in) * 100 : 0,
          conns: p.conns,
        }))
      );
      setDisabled(false);
      setErr(null);
    } catch (e) {
      if (isAxiosError(e) && e.response?.status === 503) {
        setDisabled(true);
        setRows([]);
      } else if (isAxiosError(e)) {
        const msg = (e.response?.data as { message?: string } | undefined)?.message;
        setErr(msg || e.message);
      } else {
        setErr(String(e));
      }
    }
  }, []);

  // 拉数据 + 定时自动刷新（实例/范围变化时重建）
  useEffect(() => {
    if (!selectedId) return;
    let stop = false;
    const run = async () => {
      if (stop) return;
      setLoading(true);
      await load(selectedId, cfg.step, cfg.sec);
      if (!stop) setLoading(false);
    };
    void run();
    timer.current = window.setInterval(() => void run(), REFRESH_MS);
    return () => {
      stop = true;
      if (timer.current) clearInterval(timer.current);
    };
  }, [selectedId, cfg.step, cfg.sec, load]);

  const colors = useMemo(
    () => ({
      primary: token.colorPrimary,
      error: token.colorError,
      warning: token.colorWarning,
      success: token.colorSuccess,
    }),
    [token]
  );

  const summary = useMemo(() => {
    if (rows.length === 0) return null;
    const peakReq = Math.max(...rows.map((r) => r.reqRate));
    const peakErr = Math.max(...rows.map((r) => r.errRate));
    const maxConns = Math.max(...rows.map((r) => r.conns));
    const totalReq = rows.reduce((a, r) => a + r.reqRate * cfg.step, 0);
    const totalErr = rows.reduce((a, r) => a + r.errRate * cfg.step, 0);
    const avgErrPct = totalReq > 0 ? (totalErr / totalReq) * 100 : 0;
    return { peakReq, peakErr, maxConns, avgErrPct };
  }, [rows, cfg.step]);

  const selected = instances.find((i) => i.id === selectedId);
  const chartHeight = 220;

  const chartCard = (title: ReactNode, dataKey: keyof ChartRow, color: string, unit: string, gid: string) => (
    <Card title={title} styles={{ body: { padding: 16 } }} style={{ borderRadius: 10 }}>
      {rows.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该时间范围内无数据" style={{ padding: '48px 0' }} />
      ) : (
        <ResponsiveContainer width="100%" height={chartHeight}>
          <AreaChart data={rows}>
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.55} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={token.colorBorderSecondary} />
            <XAxis
              dataKey="t"
              tickFormatter={(t) => fmtHourMinute(Number(t))}
              stroke={token.colorTextSecondary}
              fontSize={11}
              minTickGap={28}
            />
            <YAxis stroke={token.colorTextSecondary} fontSize={11} width={48} tickFormatter={(v) => fmtNum(Number(v))} />
            <RTooltip
              labelFormatter={(v) => fmtTime(Number(v))}
              formatter={(v) => [`${fmtNum(Number(v ?? 0))}${unit ? ' ' + unit : ''}`, '']}
              contentStyle={{ background: token.colorBgElevated, border: 'none', borderRadius: 8 }}
            />
            <Area type="monotone" dataKey={dataKey} stroke={color} fill={`url(#${gid})`} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </Card>
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card styles={{ body: { padding: 18 } }} style={{ borderRadius: 10 }}>
        <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }} wrap>
          <Space direction="vertical" size={2}>
            <Title level={4} style={{ margin: 0 }}>
              <LineChartOutlined /> 历史流量
            </Title>
            <Text type="secondary" style={{ fontSize: 13 }}>
              cloudflared 隧道历史指标（请求 / 错误 / HA 连接，非字节流量）。每 {REFRESH_MS / 1000}s 自动刷新。
            </Text>
          </Space>
          <Space wrap>
            <Select
              style={{ minWidth: 220 }}
              placeholder="选择实例"
              loading={instLoading}
              value={selectedId}
              onChange={setSelectedId}
              options={instances.map((i) => ({
                value: i.id,
                label: (
                  <span>
                    {i.name}
                    <Tag
                      color={i.state === 'started' ? 'green' : 'default'}
                      style={{ marginInlineStart: 6 }}
                    >
                      {STATE_LABEL[i.state]}
                    </Tag>
                  </span>
                ),
              }))}
            />
            <Segmented
              value={range}
              onChange={(v) => setRange(v as RangeKey)}
              options={RANGES.map((r) => ({ label: r.label, value: r.key }))}
            />
            <Button
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => selectedId && load(selectedId, cfg.step, cfg.sec)}
            >
              刷新
            </Button>
          </Space>
        </Space>
      </Card>

      {disabled && (
        <Alert
          type="warning"
          showIcon
          message="指标存储未启用"
          description="后端 metrics 存储处于禁用状态，无法提供历史曲线。请检查守护进程的指标存储配置。"
        />
      )}
      {err && (
        <Alert type="error" showIcon message="加载失败" description={err} closable onClose={() => setErr(null)} />
      )}

      {instLoading ? (
        <Card style={{ borderRadius: 10 }}>
          <Skeleton active />
        </Card>
      ) : instances.length === 0 ? (
        <Card style={{ borderRadius: 10 }}>
          <Empty description="还没有任何 cloudflared 实例，请先到「cloudflared 实例」页创建并启动。" />
        </Card>
      ) : !selectedId ? (
        <Card style={{ borderRadius: 10 }}>
          <Empty description="请选择一个实例查看历史流量" />
        </Card>
      ) : (
        <>
          {selected && selected.state !== 'started' && (
            <Alert
              type="info"
              showIcon
              message={`实例「${selected.name}」当前${STATE_LABEL[selected.state]}`}
              description="仅运行中的实例会持续采集指标；停止期间的时间段没有数据点。"
            />
          )}

          <Row gutter={[16, 16]}>
            <Col xs={12} sm={6}>
              <Card styles={{ body: { padding: 16 } }} style={{ borderRadius: 10 }}>
                <Statistic
                  title="峰值请求速率"
                  value={summary ? fmtNum(summary.peakReq) : '—'}
                  suffix="req/s"
                  prefix={<ApiOutlined />}
                  valueStyle={{ color: colors.primary, fontSize: 22 }}
                />
              </Card>
            </Col>
            <Col xs={12} sm={6}>
              <Card styles={{ body: { padding: 16 } }} style={{ borderRadius: 10 }}>
                <Statistic
                  title="峰值错误速率"
                  value={summary ? fmtNum(summary.peakErr) : '—'}
                  suffix="err/s"
                  prefix={<WarningOutlined />}
                  valueStyle={{ color: colors.error, fontSize: 22 }}
                />
              </Card>
            </Col>
            <Col xs={12} sm={6}>
              <Card styles={{ body: { padding: 16 } }} style={{ borderRadius: 10 }}>
                <Statistic
                  title="平均错误率"
                  value={summary ? fmtNum(summary.avgErrPct) : '—'}
                  suffix="%"
                  prefix={<PercentageOutlined />}
                  valueStyle={{ color: colors.warning, fontSize: 22 }}
                />
              </Card>
            </Col>
            <Col xs={12} sm={6}>
              <Card styles={{ body: { padding: 16 } }} style={{ borderRadius: 10 }}>
                <Statistic
                  title="峰值 HA 连接"
                  value={summary ? summary.maxConns : '—'}
                  prefix={<ClusterOutlined />}
                  valueStyle={{ color: colors.success, fontSize: 22 }}
                />
              </Card>
            </Col>
          </Row>

          {loading && rows.length === 0 ? (
            <Card style={{ borderRadius: 10 }}>
              <Skeleton active />
            </Card>
          ) : (
            <Row gutter={[16, 16]}>
              <Col xs={24} xl={12}>
                {chartCard(<Space><ApiOutlined /> 请求速率（req/s）</Space>, 'reqRate', colors.primary, 'req/s', 'tReq')}
              </Col>
              <Col xs={24} xl={12}>
                {chartCard(<Space><WarningOutlined /> 错误速率（err/s）</Space>, 'errRate', colors.error, 'err/s', 'tErr')}
              </Col>
              <Col xs={24} xl={12}>
                {chartCard(<Space><PercentageOutlined /> 错误率（%）</Space>, 'errPct', colors.warning, '%', 'tPct')}
              </Col>
              <Col xs={24} xl={12}>
                {chartCard(<Space><ClusterOutlined /> HA 连接数</Space>, 'conns', colors.success, '', 'tConn')}
              </Col>
            </Row>
          )}

          <Text type="secondary" style={{ fontSize: 12 }}>
            说明：cloudflared 不暴露按隧道的字节计数，故此处为请求/错误计数与 HA 连接数，非带宽。指标默认保留 7 天；
            HA 连接数受 cloudflared issue #1633 影响在个别版本可能偏差，硬告警以 /ready 为准。
          </Text>
        </>
      )}
    </Space>
  );
};

export default TrafficPage;
