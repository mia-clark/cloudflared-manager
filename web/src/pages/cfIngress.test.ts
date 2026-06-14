// reorderHostnames 单测：复现并锁定「实例面板拖动排序 400」的回归。
//
// 背景：实例级聚合接口 /configs/{id}/cf/public-hostnames 会把兜底规则（空 hostname 的
// http_status:404）一并列出，所以实例面板拿到的有序规则里**带兜底**。早先 reorderHostnames
// 直接 [...orderedRules, ...tail]，导致兜底出现两次（中间 + 末尾），CF 校验报
// 「Rule #N matching hostname ''，后续规则永不触发」(http 400 / 1056)。
// 修复后：reorderHostnames 先剔除传入规则里的兜底，再追加唯一兜底。

import { describe, it, expect } from 'vitest';
import { reorderHostnames, isCatchAll } from './cfIngress';
import type { CFIngressRule, CFTunnelConfig } from '../api/types';

const a: CFIngressRule = { hostname: 'a.example.com', service: 'http://localhost:1' };
const b: CFIngressRule = { hostname: 'b.example.com', service: 'http://localhost:2' };
const c: CFIngressRule = { hostname: 'c.example.com', service: 'http://localhost:3' };
const catchAll: CFIngressRule = { service: 'http_status:404' };

// CF 的硬约束：空 hostname 的兜底只能是最后一条；否则后续规则永不触发（400）。
function catchAllOnlyAtEnd(ingress: CFIngressRule[]): boolean {
  return ingress.every((r, i) => !isCatchAll(r) || i === ingress.length - 1);
}

describe('reorderHostnames', () => {
  it('仅含真实主机名的有序规则 → 追加唯一兜底（CFConsole 路径）', () => {
    const cfg: CFTunnelConfig = { ingress: [a, b, catchAll] };
    const next = reorderHostnames(cfg, [b, a]);
    expect(next.ingress).toEqual([b, a, catchAll]);
    expect(next.ingress!.filter(isCatchAll)).toHaveLength(1);
    expect(catchAllOnlyAtEnd(next.ingress!)).toBe(true);
  });

  it('有序规则混入兜底（实例面板回归）→ 兜底不重复、且只在末尾', () => {
    // 复刻 bug 触发条件：orderedRules 来自含兜底行的 hostnames，所以带上了 catchAll。
    const cfg: CFTunnelConfig = { ingress: [a, b, c, catchAll] };
    const orderedRulesWithCatchAll: CFIngressRule[] = [a, b, c, catchAll];
    const next = reorderHostnames(cfg, orderedRulesWithCatchAll);
    expect(next.ingress!.filter(isCatchAll)).toHaveLength(1); // 不再出现两次
    expect(catchAllOnlyAtEnd(next.ingress!)).toBe(true); // 兜底前面没有真实规则被挡住
    expect(next.ingress).toEqual([a, b, c, catchAll]);
  });

  it('用户把兜底行拖到中间 → 仍归位到末尾', () => {
    const cfg: CFTunnelConfig = { ingress: [a, b, catchAll] };
    const reordered: CFIngressRule[] = [a, catchAll, b]; // 兜底被拖到中间
    const next = reorderHostnames(cfg, reordered);
    expect(next.ingress).toEqual([a, b, catchAll]);
    expect(catchAllOnlyAtEnd(next.ingress!)).toBe(true);
  });

  it('原配置无兜底 → 自动补 http_status:404 收尾', () => {
    const cfg: CFTunnelConfig = { ingress: [a] };
    const next = reorderHostnames(cfg, [a]);
    expect(next.ingress).toEqual([a, { service: 'http_status:404' }]);
  });

  it('保留 config 的其它字段（warp-routing 等）', () => {
    const cfg: CFTunnelConfig = { ingress: [a, catchAll], 'warp-routing': { enabled: true } };
    const next = reorderHostnames(cfg, [a]);
    expect(next['warp-routing']).toEqual({ enabled: true });
  });

  it('config 为 null 也不崩，兜底兜底', () => {
    const next = reorderHostnames(null, [a]);
    expect(next.ingress).toEqual([a, { service: 'http_status:404' }]);
  });
});
