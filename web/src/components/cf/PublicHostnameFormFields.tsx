// 公共主机名表单字段（CFConsole 与 InstanceCFPanel 共用）。
//
// 仅渲染 Form.Item 字段，需被包裹在外层 <Form> 内使用。仿 Cloudflare 官方后台，
// 公共主机名拆成「子域前缀 subdomain + 域名 zoneName（来自账号 zone 列表的可搜索下拉）」，
// 提交时由 cfIngress.buildHostname 合成完整 hostname。折叠面板内为 originRequest（共享组件）。

import { Form, Input, Select, Switch, Collapse, Row, Col, Typography } from 'antd';
import { SERVICE_TYPES, buildHostname, type ServiceType } from '../../pages/cfIngress';
import type { CFZone } from '../../api/types';
import OriginRequestFields from './OriginRequestFields';

const { Text } = Typography;

interface Props {
  // 是否展示「同步代理 CNAME」开关（CFConsole 与实例级聚合都需要，故默认展示）。
  showManageDns?: boolean;
  // 目标地址占位符随服务类型变化，靠 watch serviceType 实现。
  serviceTypeWatch?: ServiceType;
  // 账号下的 zone 列表（域名下拉数据源）。
  zones: CFZone[];
  zonesLoading?: boolean;
  // 实时值（外层 Form.useWatch 注入），用于域名后缀提示与完整主机名预览。
  zoneNameWatch?: string;
  subdomainWatch?: string;
}

export default function PublicHostnameFormFields({
  showManageDns = true,
  serviceTypeWatch,
  zones,
  zonesLoading = false,
  zoneNameWatch,
  subdomainWatch,
}: Props) {
  const isHttpStatus = serviceTypeWatch === 'http_status';
  const isUnix = serviceTypeWatch === 'unix';
  const targetPlaceholder = isHttpStatus
    ? '如 404'
    : isUnix
      ? '如 /var/run/app.sock'
      : '如 localhost:8080';

  // 域名下拉选项：账号 zone 列表；若当前选中的 zoneName 不在列表（编辑历史值/zone 不在本账号），
  // 注入一项以免下拉显示空白。
  const zoneOptions = zones.map((z) => ({ value: z.name, label: z.name }));
  if (zoneNameWatch && !zones.some((z) => z.name === zoneNameWatch)) {
    zoneOptions.unshift({ value: zoneNameWatch, label: zoneNameWatch });
  }

  const fullHostname = buildHostname(subdomainWatch, zoneNameWatch);

  return (
    <>
      <Row gutter={16} align="bottom">
        <Col xs={24} md={10}>
          <Form.Item
            label="子域 / 前缀（可选）"
            name="subdomain"
            tooltip="留空 = 直接用根域名（如 example.com）；填 app = app.example.com。支持多级，如 a.b"
          >
            <Input placeholder="app（留空 = 根域名）" allowClear addonAfter={zoneNameWatch ? `.${zoneNameWatch}` : undefined} />
          </Form.Item>
        </Col>
        <Col xs={24} md={14}>
          <Form.Item
            label="域名（zone）"
            name="zoneName"
            rules={[{ required: true, message: '请选择域名' }]}
            tooltip="从该 Cloudflare 账号已托管的 zone 中选择，可输入关键字搜索"
          >
            <Select
              showSearch
              placeholder="选择域名（可搜索）"
              optionFilterProp="label"
              loading={zonesLoading}
              options={zoneOptions}
              notFoundContent={zonesLoading ? '加载中…' : '该账号下无可用域名（确认 token 有 Zone:Read 权限）'}
            />
          </Form.Item>
        </Col>
      </Row>

      <div style={{ marginTop: -8, marginBottom: 14 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          完整主机名：{fullHostname ? <Text code>{fullHostname}</Text> : <Text type="secondary">（选择域名后生成）</Text>}
        </Text>
      </div>

      <Form.Item label="路径（path，可选）" name="path" tooltip="可选，按路径前缀路由，如 /api">
        <Input placeholder="/（留空匹配全部路径）" allowClear />
      </Form.Item>

      <Row gutter={16}>
        <Col xs={24} sm={8}>
          <Form.Item
            label="服务类型"
            name="serviceType"
            rules={[{ required: true, message: '请选择服务类型' }]}
          >
            <Select options={SERVICE_TYPES.map((t) => ({ value: t.value, label: t.label }))} />
          </Form.Item>
        </Col>
        <Col xs={24} sm={16}>
          <Form.Item
            label="目标地址（service）"
            name="serviceTarget"
            tooltip="回源目标，会拼成 cloudflared service 字符串，如 http://localhost:8080"
            rules={[{ required: !isHttpStatus, message: '请输入回源目标地址' }]}
          >
            <Input placeholder={targetPlaceholder} />
          </Form.Item>
        </Col>
      </Row>

      {showManageDns && (
        <Form.Item
          label="同步代理 CNAME（manage_dns）"
          name="manage_dns"
          valuePropName="checked"
          tooltip="开启后自动在对应 zone 创建/更新指向本隧道的代理 CNAME 记录"
          extra={<Text type="secondary" style={{ fontSize: 12 }}>开启后自动在对应 zone 创建/更新指向本隧道的代理 CNAME 记录</Text>}
        >
          <Switch checkedChildren="自动同步" unCheckedChildren="不同步" />
        </Form.Item>
      )}

      <Collapse
        size="small"
        ghost
        style={{ marginTop: 4 }}
        items={[
          {
            key: 'advanced',
            label: '高级 originRequest（全部可选，仅填了的才生效）',
            children: <OriginRequestFields />,
          },
        ]}
      />
    </>
  );
}
