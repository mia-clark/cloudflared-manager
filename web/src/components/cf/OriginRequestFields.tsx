// originRequest 表单字段（CFConsole 全局配置 与 公共主机名 高级区共用）。
//
// 仅渲染 Form.Item，需被包裹在外层 <Form layout="vertical"> 内使用。字段命名与
// cfIngress.ts 的 OriginRequestFormValues 对齐。按语义分组（超时连接 / 回源行为 /
// 回源标识 / 出站代理 / Access）并用 Row/Col 网格排布，宽屏自适应多列、窄屏自动堆叠，
// 比原先一行挤多个 flex 输入框清爽得多。
//
// 时长字段（connectTimeout / tlsTimeout / tcpKeepAlive / keepAliveTimeout）用
// InputNumber「秒」——CF API 要数字秒，发字符串会 400（见 cfIngress.ts 注释）。

import { Form, Input, InputNumber, Select, Switch, Row, Col, Divider, Typography } from 'antd';

const { Text } = Typography;

function Section({ children }: { children: React.ReactNode }) {
  return (
    <Divider titlePlacement="left" style={{ margin: '8px 0 14px' }}>
      <Text type="secondary" style={{ fontSize: 12, fontWeight: 600, letterSpacing: 0.3 }}>
        {children}
      </Text>
    </Divider>
  );
}

// 时长数字输入（秒）。precision=0 限制整数，避免 30.5 这类小数被 CF 的 ParseInt 拒绝。
function SecondsField({ name, label, placeholder, tip }: { name: string; label: string; placeholder: string; tip: string }) {
  return (
    <Col xs={12} sm={8} lg={6}>
      <Form.Item label={label} name={name} tooltip={tip} style={{ marginBottom: 14 }}>
        <InputNumber min={0} precision={0} addonAfter="秒" placeholder={placeholder} style={{ width: '100%' }} />
      </Form.Item>
    </Col>
  );
}

function ToggleField({ name, label, tip }: { name: string; label: string; tip: string }) {
  return (
    <Col xs={12} sm={6}>
      <Form.Item label={label} name={name} valuePropName="checked" tooltip={tip} style={{ marginBottom: 8 }}>
        <Switch />
      </Form.Item>
    </Col>
  );
}

export default function OriginRequestFields() {
  return (
    <div>
      <Section>超时与连接（单位：秒）</Section>
      <Row gutter={16}>
        <SecondsField name="connectTimeout" label="connectTimeout" placeholder="30" tip="建立到回源的 TCP 连接超时，默认 30 秒" />
        <SecondsField name="tlsTimeout" label="tlsTimeout" placeholder="10" tip="回源 TLS 握手超时，默认 10 秒" />
        <SecondsField name="tcpKeepAlive" label="tcpKeepAlive" placeholder="30" tip="TCP keep-alive 间隔，默认 30 秒" />
        <SecondsField name="keepAliveTimeout" label="keepAliveTimeout" placeholder="90" tip="空闲连接保活超时，默认 90 秒" />
        <Col xs={12} sm={8} lg={6}>
          <Form.Item label="keepAliveConnections" name="keepAliveConnections" tooltip="连接池最大空闲连接数，默认 100" style={{ marginBottom: 14 }}>
            <InputNumber min={0} precision={0} placeholder="100" style={{ width: '100%' }} />
          </Form.Item>
        </Col>
      </Row>

      <Section>回源行为</Section>
      <Row gutter={16}>
        <ToggleField name="http2Origin" label="http2Origin" tip="以 HTTP/2 连接回源" />
        <ToggleField name="noTLSVerify" label="noTLSVerify" tip="跳过回源 TLS 证书校验（自签名证书常用）" />
        <ToggleField name="noHappyEyeballs" label="noHappyEyeballs" tip="禁用 Happy Eyeballs（IPv4/IPv6 并发拨号）" />
        <ToggleField name="disableChunkedEncoding" label="disableChunkedEncoding" tip="禁用分块传输编码（部分老旧回源需要）" />
      </Row>

      <Section>回源标识与证书</Section>
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item label="httpHostHeader" name="httpHostHeader" tooltip="覆盖发往回源的 Host 头" style={{ marginBottom: 14 }}>
            <Input placeholder="覆盖回源 Host 头" allowClear />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item label="originServerName" name="originServerName" tooltip="回源 TLS 校验用的 SNI / 服务器名" style={{ marginBottom: 14 }}>
            <Input placeholder="origin.example.com" allowClear />
          </Form.Item>
        </Col>
        <Col xs={24}>
          <Form.Item label="caPool" name="caPool" tooltip="回源校验用的 CA 证书路径" style={{ marginBottom: 14 }}>
            <Input placeholder="/path/to/ca.pem" allowClear />
          </Form.Item>
        </Col>
      </Row>

      <Section>出站代理（可选）</Section>
      <Row gutter={16}>
        <Col xs={24} sm={8}>
          <Form.Item label="proxyType" name="proxyType" tooltip="如 socks，留空为直连" style={{ marginBottom: 14 }}>
            <Input placeholder="socks" allowClear />
          </Form.Item>
        </Col>
        <Col xs={24} sm={8}>
          <Form.Item label="proxyAddress" name="proxyAddress" style={{ marginBottom: 14 }}>
            <Input placeholder="127.0.0.1" allowClear />
          </Form.Item>
        </Col>
        <Col xs={24} sm={8}>
          <Form.Item label="proxyPort" name="proxyPort" style={{ marginBottom: 14 }}>
            <InputNumber min={0} max={65535} precision={0} placeholder="1080" style={{ width: '100%' }} />
          </Form.Item>
        </Col>
      </Row>

      <Section>Access（保护此主机名，可选）</Section>
      <Row gutter={16} align="bottom">
        <Col xs={12} sm={6}>
          <Form.Item label="access.required" name="access_required" valuePropName="checked" tooltip="开启后需通过 Cloudflare Access 鉴权才能访问" style={{ marginBottom: 14 }}>
            <Switch />
          </Form.Item>
        </Col>
        <Col xs={24} sm={18}>
          <Form.Item label="access.teamName" name="access_teamName" tooltip="Access 团队名（your-team.cloudflareaccess.com 的 your-team）" style={{ marginBottom: 14 }}>
            <Input placeholder="your-team" allowClear />
          </Form.Item>
        </Col>
        <Col xs={24}>
          <Form.Item label="access.audTag" name="access_audTag" tooltip="Access 应用的 AUD 标签，可填多个" style={{ marginBottom: 0 }}>
            <Select mode="tags" placeholder="回车输入一个或多个 AUD" tokenSeparators={[',', ' ']} />
          </Form.Item>
        </Col>
      </Row>
    </div>
  );
}
