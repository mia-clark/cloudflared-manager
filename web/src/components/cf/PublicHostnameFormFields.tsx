// 公共主机名表单字段（CFConsole 与 InstanceCFPanel 共用）。
//
// 仅渲染 Form.Item 字段，需被包裹在外层 <Form> 内使用。字段命名与
// cfIngress.ts 的 PublicHostnameFormValues 对齐：顶部 hostname/path/服务类型/
// 目标地址；折叠面板内为打平的 originRequest 字段（共享 OriginRequestFields）。

import { Form, Input, Select, Switch, Collapse, Row, Col, Typography } from 'antd';
import { SERVICE_TYPES, type ServiceType } from '../../pages/cfIngress';
import OriginRequestFields from './OriginRequestFields';

const { Text } = Typography;

interface Props {
  // 是否展示「同步代理 CNAME」开关（CFConsole 与实例级聚合都需要，故默认展示）。
  showManageDns?: boolean;
  // 目标地址占位符随服务类型变化，靠 watch serviceType 实现。
  serviceTypeWatch?: ServiceType;
}

export default function PublicHostnameFormFields({ showManageDns = true, serviceTypeWatch }: Props) {
  const isHttpStatus = serviceTypeWatch === 'http_status';
  const isUnix = serviceTypeWatch === 'unix';
  const targetPlaceholder = isHttpStatus
    ? '如 404'
    : isUnix
      ? '如 /var/run/app.sock'
      : '如 localhost:8080';

  return (
    <>
      <Row gutter={16}>
        <Col xs={24} md={14}>
          <Form.Item
            label="公共主机名（hostname）"
            name="hostname"
            rules={[{ required: true, message: '请输入完整主机名，如 app.example.com' }]}
            tooltip="用户访问用的完整域名，须为本账号已托管 zone 的子域"
          >
            <Input placeholder="app.example.com" />
          </Form.Item>
        </Col>
        <Col xs={24} md={10}>
          <Form.Item label="路径（path，可选）" name="path" tooltip="可选，按路径前缀路由，如 /api">
            <Input placeholder="/（留空匹配全部路径）" allowClear />
          </Form.Item>
        </Col>
      </Row>

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
