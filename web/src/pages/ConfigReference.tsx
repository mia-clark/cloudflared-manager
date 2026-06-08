import { useMemo, useState } from 'react';
import {
  Card, Space, Typography, Tag, Table, Input, Switch, Button, Alert, Divider, App,
  theme as antdTheme,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ReadOutlined, CopyOutlined, SearchOutlined, ThunderboltOutlined,
  SafetyCertificateOutlined, ToolOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';

import {
  CATALOG, EXTRA_ALLOWED_ENV, RESERVED_ENV, modelledEnvKeys,
  fieldSnippet, FULL_EXAMPLE, MINIMAL_EXAMPLE,
  type CatalogGroup, type FieldDef,
} from './configCatalog';

const { Title, Text, Paragraph } = Typography;
const MONO = `'Cascadia Code', Consolas, 'SF Mono', Menlo, ui-monospace, monospace`;

const ConfigReference: React.FC = () => {
  const { token } = antdTheme.useToken();
  const { message } = App.useApp();
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(true);

  const copy = (s: string, tip = '已复制') => {
    navigator.clipboard.writeText(s).then(
      () => message.success(tip),
      () => message.error('复制失败，请手动选择'),
    );
  };

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    return CATALOG.map((g) => ({
      ...g,
      fields: g.fields.filter(
        (f) =>
          (showAdvanced || !f.advanced) &&
          (q === '' ||
            f.path.toLowerCase().includes(q) ||
            f.desc.toLowerCase().includes(q) ||
            (f.allowed || '').toLowerCase().includes(q) ||
            (f.env || '').toLowerCase().includes(q)),
      ),
    })).filter((g) => g.fields.length > 0);
  }, [q, showAdvanced]);

  const columns = (group: CatalogGroup): ColumnsType<FieldDef> => [
    {
      title: '字段',
      dataIndex: 'path',
      key: 'path',
      width: 220,
      render: (path: string, f) => (
        <Space size={4} wrap>
          <Text code copyable={{ text: path, tooltips: ['复制键名', '已复制'] }} style={{ fontFamily: MONO, fontSize: 12.5 }}>
            {path}
          </Text>
          {f.advanced && <Tag color="default" style={{ marginInlineStart: 0 }}>高级</Tag>}
        </Space>
      ),
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      width: 130,
      render: (t: string) => <Tag color="blue" style={{ fontFamily: MONO, fontSize: 11.5 }}>{t}</Tag>,
    },
    {
      title: '允许值 / 默认',
      key: 'allowed',
      width: 230,
      render: (_, f) => (
        <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>
          {f.allowed && <div>{f.allowed}</div>}
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>默认：</Text>
            <Text style={{ fontFamily: MONO, fontSize: 12 }}>{f.default || '—'}</Text>
          </div>
          {f.constraint && (
            <div>
              <Text type="warning" style={{ fontSize: 11.5 }}>约束：{f.constraint}</Text>
            </div>
          )}
        </div>
      ),
    },
    {
      title: '对应 env',
      dataIndex: 'env',
      key: 'env',
      width: 200,
      render: (e: string) =>
        e && e.startsWith('TUNNEL_') ? (
          <Text code style={{ fontFamily: MONO, fontSize: 11.5 }}>{e}</Text>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>{e || '—'}</Text>
        ),
    },
    {
      title: '说明',
      dataIndex: 'desc',
      key: 'desc',
      render: (d: string) => <Text style={{ fontSize: 12.5 }}>{d}</Text>,
    },
    {
      title: '',
      key: 'op',
      width: 88,
      align: 'right',
      render: (_, f) => (
        <Button
          size="small"
          type="text"
          icon={<CopyOutlined />}
          onClick={() => copy(fieldSnippet(group, f), `已复制 ${f.path} 片段`)}
        >
          片段
        </Button>
      ),
    },
  ];

  const CodeBlock: React.FC<{ code: string; copyTip?: string }> = ({ code, copyTip }) => (
    <div style={{ position: 'relative' }}>
      <Button
        size="small"
        icon={<CopyOutlined />}
        onClick={() => copy(code, copyTip)}
        style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}
      >
        复制
      </Button>
      <pre
        style={{
          margin: 0,
          padding: '14px 16px',
          background: '#0b0f14',
          color: '#cdd6e4',
          borderRadius: 8,
          fontFamily: MONO,
          fontSize: 12.5,
          lineHeight: 1.65,
          overflowX: 'auto',
          border: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        {code}
      </pre>
    </div>
  );

  const modelled = modelledEnvKeys();

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* Hero */}
      <Card styles={{ body: { padding: 0 } }} style={{ borderRadius: 12, overflow: 'hidden', border: `1px solid ${token.colorBorderSecondary}` }}>
        <div style={{ padding: '28px 28px', background: 'linear-gradient(135deg, #0f172a 0%, #1e3a8a 45%, #6d28d9 100%)', color: '#fff' }}>
          <Space size={14} align="center">
            <div style={{ width: 52, height: 52, borderRadius: 13, background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.3)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <ReadOutlined style={{ fontSize: 28, color: '#fff' }} />
            </div>
            <div>
              <Title level={2} style={{ color: '#fff', margin: 0, fontWeight: 700 }}>配置参考 · YAML 参数速查</Title>
              <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 13.5 }}>
                cloudflared 隧道（token 模式）全部可配参数，逐字段可复制
              </Text>
            </div>
          </Space>
        </div>
      </Card>

      {/* 关键提示 */}
      <Alert
        type="info"
        showIcon
        message="token 模式速记"
        description={
          <ul style={{ margin: '4px 0 0', paddingInlineStart: 18, fontSize: 13, lineHeight: 1.8 }}>
            <li><b>token 必填</b>：启动前校验长度 100–1500、base64 字符集；其余字段<b>留空 = 用 cloudflared 默认</b>。</li>
            <li><b>ingress / 公开主机名 / origin</b> 在 Cloudflare Zero Trust dashboard 配置，<b>不在这里</b>。</li>
            <li>结构是<b>嵌套</b>的（edge / reliability / logging / identity），别拍平成顶层键，否则保存 400。</li>
            <li>键名大小写敏感：<Text code style={{ fontFamily: MONO }}>edgeIpVersion</Text>（小写 p）、<Text code style={{ fontFamily: MONO }}>postQuantum</Text>、<Text code style={{ fontFamily: MONO }}>gracePeriod</Text>。</li>
          </ul>
        }
      />

      {/* 工具栏 */}
      <Card styles={{ body: { padding: 12 } }} style={{ borderRadius: 10 }}>
        <Space wrap size={12} style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space wrap size={12}>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索字段 / env / 说明…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ width: 280 }}
            />
            <Space size={6}>
              <Switch checked={showAdvanced} onChange={setShowAdvanced} size="small" />
              <Text type="secondary" style={{ fontSize: 13 }}>显示高级参数</Text>
            </Space>
          </Space>
          <Space wrap size={8}>
            <Button icon={<CopyOutlined />} onClick={() => copy(MINIMAL_EXAMPLE, '已复制最小示例')}>复制最小示例</Button>
            <Button type="primary" icon={<CopyOutlined />} onClick={() => copy(FULL_EXAMPLE, '已复制完整示例')}>复制完整示例 YAML</Button>
            <Button icon={<ToolOutlined />} onClick={() => navigate('/tools/validate')}>去校验</Button>
          </Space>
        </Space>
      </Card>

      {/* 完整示例 */}
      <Card title={<Space><ThunderboltOutlined /> 完整示例 YAML（覆盖全部参数）</Space>} style={{ borderRadius: 10 }} styles={{ header: { background: token.colorFillTertiary } }}>
        <CodeBlock code={FULL_EXAMPLE} copyTip="已复制完整示例" />
      </Card>

      {/* 分组参数表 */}
      {groups.map((g) => (
        <Card
          key={g.key}
          title={
            <Space>
              <SafetyCertificateOutlined style={{ color: token.colorPrimary }} />
              <span>{g.title}</span>
              {g.yamlKey && <Tag color="purple" style={{ fontFamily: MONO }}>{g.yamlKey}:</Tag>}
            </Space>
          }
          extra={<Text type="secondary" style={{ fontSize: 12 }}>{g.fields.length} 项</Text>}
          style={{ borderRadius: 10 }}
          styles={{ header: { background: token.colorFillTertiary } }}
        >
          <Paragraph type="secondary" style={{ marginTop: -4, marginBottom: 12, fontSize: 13 }}>{g.desc}</Paragraph>
          <Table<FieldDef>
            size="small"
            rowKey="path"
            columns={columns(g)}
            dataSource={g.fields}
            pagination={false}
            scroll={{ x: 880 }}
          />
        </Card>
      ))}

      {groups.length === 0 && (
        <Card style={{ borderRadius: 10, textAlign: 'center', padding: 24 }}>
          <Text type="secondary">没有匹配「{query}」的字段。</Text>
        </Card>
      )}

      {/* env 白名单 */}
      <Card title={<Space><ThunderboltOutlined /> advancedEnvOverrides · 可用与保留的 env</Space>} style={{ borderRadius: 10 }} styles={{ header: { background: token.colorFillTertiary } }}>
        <Paragraph type="secondary" style={{ fontSize: 13 }}>
          逃生舱：当某 cloudflared 变量未被上面字段建模时可在此直接注入。<b>非白名单键会在启动时被静默丢弃</b>（「配置校验」会给出警告）。
        </Paragraph>

        <Text strong style={{ fontSize: 13 }}>① 已建模字段对应的 env（也可经此重复设置）</Text>
        <div style={{ margin: '8px 0 16px' }}>
          <Space wrap size={[6, 8]}>
            {modelled.map((k) => (
              <Tag key={k} color="blue" style={{ fontFamily: MONO, fontSize: 11.5, cursor: 'pointer' }} onClick={() => copy(k, '已复制 ' + k)}>{k}</Tag>
            ))}
          </Space>
        </div>

        <Text strong style={{ fontSize: 13 }}>② 额外放行（未建模，高级用途）</Text>
        <div style={{ margin: '8px 0 16px' }}>
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {EXTRA_ALLOWED_ENV.map((e) => (
              <div key={e.key}>
                <Tag color="geekblue" style={{ fontFamily: MONO, fontSize: 11.5, cursor: 'pointer' }} onClick={() => copy(e.key, '已复制 ' + e.key)}>{e.key}</Tag>
                <Text type="secondary" style={{ fontSize: 12.5 }}>{e.desc}</Text>
              </div>
            ))}
          </Space>
        </div>

        <Text strong style={{ fontSize: 13 }}>③ 保留键（cfdmgrd 自管，无法覆盖）</Text>
        <div style={{ margin: '8px 0 16px' }}>
          <Space wrap size={[6, 8]}>
            {RESERVED_ENV.map((k) => (
              <Tag key={k} color="red" style={{ fontFamily: MONO, fontSize: 11.5 }}>{k}</Tag>
            ))}
          </Space>
        </div>

        <Divider style={{ margin: '8px 0 14px' }} />
        <Text strong style={{ fontSize: 13 }}>示例片段</Text>
        <div style={{ marginTop: 8 }}>
          <CodeBlock
            code={`advancedEnvOverrides:\n  TUNNEL_DNS_RESOLVER_ADDRS: 1.1.1.1,1.0.0.1\n  TUNNEL_METRICS_UPDATE_FREQ: 5s\n`}
            copyTip="已复制 advancedEnvOverrides 示例"
          />
        </div>
      </Card>

      <Text type="secondary" style={{ fontSize: 12, display: 'block', textAlign: 'center', paddingBottom: 8 }}>
        字段权威来源：pkg/cfdflags（registry / mapping / whitelist） + pkg/cfdconfig（tunnel / validate）。与「配置校验」页配合使用。
      </Text>
    </Space>
  );
};

export default ConfigReference;
