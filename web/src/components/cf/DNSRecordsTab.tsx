// 「DNS 记录」Tab：选 zone → 列记录 → 增删改。

import { useCallback, useEffect, useState } from 'react';
import {
  Card,
  Table,
  Button,
  Space,
  Tag,
  Empty,
  Select,
  Modal,
  Form,
  Input,
  InputNumber,
  Switch,
  Typography,
  App,
  Popconfirm,
  Tooltip,
  Row,
  Col,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined, ReloadOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { cfApi } from '../../api/client';
import type { CFZone, CFDNSRecord } from '../../api/types';

const { Text } = Typography;

const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA'];

// 子域前缀 + zone → 完整记录名（仿 Cloudflare 官方：只填子域，根域名用 @）。
function dnsCombine(subdomain: string, zoneName: string): string {
  const s = (subdomain || '').trim().replace(/^\.+|\.+$/g, '');
  if (!zoneName) return s;
  if (!s || s === '@') return zoneName; // 根域名（apex）
  const sl = s.toLowerCase();
  const zl = zoneName.toLowerCase();
  if (sl === zl || sl.endsWith('.' + zl)) return s; // 用户已填完整 FQDN，原样
  return `${s}.${zoneName}`;
}

// 完整记录名 → 子域前缀（编辑回填）。等于 zone 本身 → @；在 zone 下 → 去掉后缀；否则原样。
function dnsSplit(name: string, zoneName: string): string {
  const n = (name || '').trim();
  if (!zoneName || !n) return '';
  const nl = n.toLowerCase();
  const zl = zoneName.toLowerCase();
  if (nl === zl) return '@';
  if (nl.endsWith('.' + zl)) return n.slice(0, n.length - zoneName.length - 1);
  return n;
}

interface Props {
  aid: string;
}

interface DNSFormValues {
  type: string;
  subdomain: string;
  content: string;
  proxied: boolean;
  ttl: number;
}

export default function DNSRecordsTab({ aid }: Props) {
  const { message } = App.useApp();
  const [form] = Form.useForm<DNSFormValues>();

  const [zones, setZones] = useState<CFZone[]>([]);
  const [zoneId, setZoneId] = useState<string>('');
  const [records, setRecords] = useState<CFDNSRecord[]>([]);
  const [zonesLoading, setZonesLoading] = useState(false);
  const [recordsLoading, setRecordsLoading] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CFDNSRecord | null>(null);
  const [saving, setSaving] = useState(false);

  const errMsg = (err: unknown): string => {
    const e = err as { response?: { data?: { error?: { message?: string } } }; message?: string };
    return e.response?.data?.error?.message || e.message || '未知错误';
  };

  const loadZones = useCallback(async () => {
    setZonesLoading(true);
    try {
      const resp = await cfApi.listZones(aid);
      const items = resp.data?.items || [];
      setZones(items);
      if (items.length > 0) setZoneId((prev) => prev || items[0].id);
    } catch (err: unknown) {
      message.error('获取 zone 列表失败：' + errMsg(err));
    } finally {
      setZonesLoading(false);
    }
  }, [aid, message]);

  const loadRecords = useCallback(
    async (zid: string) => {
      if (!zid) {
        setRecords([]);
        return;
      }
      setRecordsLoading(true);
      try {
        const resp = await cfApi.listDNS(aid, zid);
        setRecords(resp.data?.items || []);
      } catch (err: unknown) {
        message.error('获取 DNS 记录失败：' + errMsg(err));
      } finally {
        setRecordsLoading(false);
      }
    },
    [aid, message]
  );

  useEffect(() => {
    loadZones();
  }, [loadZones]);

  useEffect(() => {
    loadRecords(zoneId);
  }, [zoneId, loadRecords]);

  const zoneName = zones.find((z) => z.id === zoneId)?.name || '';

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ type: 'CNAME', subdomain: '', proxied: true, ttl: 1 });
    setModalOpen(true);
  };

  const openEdit = (rec: CFDNSRecord) => {
    setEditing(rec);
    form.resetFields();
    form.setFieldsValue({
      type: rec.type || 'CNAME',
      subdomain: dnsSplit(rec.name || '', zoneName),
      content: rec.content || '',
      proxied: !!rec.proxied,
      ttl: rec.ttl ?? 1,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    let values: DNSFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const rec: CFDNSRecord = {
      type: values.type,
      name: dnsCombine(values.subdomain, zoneName),
      content: values.content.trim(),
      proxied: values.proxied,
      ttl: values.proxied ? 1 : values.ttl ?? 1,
    };
    setSaving(true);
    try {
      if (editing && editing.id) {
        await cfApi.updateDNS(aid, zoneId, editing.id, rec);
        message.success('DNS 记录已更新');
      } else {
        await cfApi.createDNS(aid, zoneId, rec);
        message.success('DNS 记录已创建');
      }
      setModalOpen(false);
      loadRecords(zoneId);
    } catch (err: unknown) {
      message.error('保存失败：' + errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (rec: CFDNSRecord) => {
    if (!rec.id) return;
    try {
      await cfApi.deleteDNS(aid, zoneId, rec.id);
      message.success('DNS 记录已删除');
      loadRecords(zoneId);
    } catch (err: unknown) {
      message.error('删除失败：' + errMsg(err));
    }
  };

  const columns: ColumnsType<CFDNSRecord> = [
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      width: 90,
      render: (v: string) => <Tag color="geekblue">{v}</Tag>,
    },
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      render: (v: string) => <Text strong>{v}</Text>,
    },
    {
      title: '内容',
      dataIndex: 'content',
      key: 'content',
      render: (v: string) => <Text code style={{ fontSize: 12 }}>{v}</Text>,
    },
    {
      title: '代理',
      dataIndex: 'proxied',
      key: 'proxied',
      width: 90,
      align: 'center',
      render: (v: boolean) => (v ? <Tag color="warning">已代理</Tag> : <Tag>仅 DNS</Tag>),
    },
    {
      title: 'TTL',
      dataIndex: 'ttl',
      key: 'ttl',
      width: 90,
      align: 'right',
      render: (v: number) => (v === 1 ? <Text type="secondary">自动</Text> : v),
    },
    {
      title: '操作',
      key: 'actions',
      width: 100,
      align: 'right',
      render: (_, r) => (
        <Space size={4}>
          <Tooltip title="编辑">
            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
          </Tooltip>
          <Popconfirm
            title="删除该 DNS 记录？"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => handleDelete(r)}
          >
            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const proxiedWatch = Form.useWatch('proxied', form);
  const subdomainWatch = Form.useWatch('subdomain', form);
  const fullName = dnsCombine(subdomainWatch || '', zoneName);

  return (
    <Card
      size="small"
      style={{ borderRadius: 10 }}
      title="DNS 记录"
      extra={
        <Space>
          <Select
            size="small"
            style={{ width: 220 }}
            placeholder="选择 zone"
            value={zoneId || undefined}
            onChange={setZoneId}
            loading={zonesLoading}
            showSearch
            optionFilterProp="label"
            options={zones.map((z) => ({ value: z.id, label: z.name }))}
          />
          <Button size="small" icon={<ReloadOutlined />} onClick={() => loadRecords(zoneId)} loading={recordsLoading}>
            刷新
          </Button>
          <Button size="small" type="primary" icon={<PlusOutlined />} disabled={!zoneId} onClick={openCreate}>
            新建记录
          </Button>
        </Space>
      }
    >
      <Table<CFDNSRecord>
        size="small"
        rowKey={(r) => r.id || `${r.type}-${r.name}-${r.content}`}
        columns={columns}
        dataSource={records}
        loading={recordsLoading}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={zoneId ? '该 zone 暂无 DNS 记录' : '请先选择一个 zone'}
            />
          ),
        }}
      />

      <Modal
        title={editing ? '编辑 DNS 记录' : '新建 DNS 记录'}
        open={modalOpen}
        onOk={submit}
        confirmLoading={saving}
        onCancel={() => setModalOpen(false)}
        okText="保存"
        cancelText="取消"
        destroyOnClose
        width={580}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Row gutter={16}>
            <Col xs={24} sm={7}>
              <Form.Item label="类型" name="type" rules={[{ required: true }]}>
                <Select options={DNS_TYPES.map((t) => ({ value: t, label: t }))} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={17}>
              <Form.Item
                label="名称（子域）"
                name="subdomain"
                tooltip="只填子域前缀（二级，如 app）；根域名填 @ 或留空。完整记录名 = 子域 + 当前所选 zone。"
              >
                <Input placeholder="app（根域名填 @ 或留空）" addonAfter={zoneName ? `.${zoneName}` : undefined} allowClear />
              </Form.Item>
            </Col>
          </Row>

          <div style={{ marginTop: -8, marginBottom: 14 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              完整记录名：{fullName ? <Text code>{fullName}</Text> : <Text type="secondary">（选择 zone 并填子域后生成）</Text>}
            </Text>
          </div>

          <Form.Item label="内容" name="content" rules={[{ required: true, message: '请输入记录内容' }]}>
            <Input placeholder="如 1.2.3.4 / xxx.cfargotunnel.com" />
          </Form.Item>

          <Row gutter={16} align="bottom">
            <Col xs={12} sm={10}>
              <Form.Item label="Cloudflare 代理" name="proxied" valuePropName="checked" tooltip="开启后经 Cloudflare 边缘代理（橙云）；仅 DNS 则直连。">
                <Switch checkedChildren="代理" unCheckedChildren="仅 DNS" />
              </Form.Item>
            </Col>
            <Col xs={12} sm={10}>
              <Form.Item label="TTL（秒，1=自动）" name="ttl" tooltip="开启代理时 TTL 固定为自动（1）。">
                <InputNumber style={{ width: '100%' }} min={1} precision={0} disabled={!!proxiedWatch} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </Card>
  );
}
