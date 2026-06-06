# E2E Tests

基于 Playwright 的端到端测试，覆盖 frpsmgrd Web 面板的关键回归路径。

## 前置

- Node 20+
- 项目已构建出 daemon 二进制：

```bash
# 推荐
make build-host

# 或手动
cd web && npm run build
cd .. && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o bin/frpsmgrd.exe ./cmd/frpsmgrd
```

> globalSetup 按顺序找 `bin/frpsmgrd-dev[.exe]` → `bin/frpsmgrd[.exe]`。

## 首次安装浏览器

```bash
cd web
npm run test:e2e:install      # 安装 Chromium
```

## 跑测试

```bash
cd web
npm run test:e2e              # 无头运行
npm run test:e2e:ui           # Playwright UI 模式（调试）
npm run test:e2e:report       # 跑完后查看 HTML 报告
```

只跑某一个 spec：

```bash
npm run test:e2e -- 01-frps-lifecycle.spec.ts
```

## 架构

- 每个 spec 用 `fixtures/daemon.ts` 拿到独立 daemon fixture：
  - 启独立 `frpsmgrd[-dev].exe` 子进程
  - 监听 `:18080 + workerIndex`（端口逐 worker 偏移）
  - 独立 `e2e-tmp/<workerN>-<rand>/` 数据目录
  - 子进程 stdout/stderr 落到 `daemon.log`
- 串行 (`workers: 1`) 避免端口冲突
- 测试结束：
  - 成功：自动 kill daemon + 删 TempDir
  - 失败：kill daemon，**保留** TempDir 供事后查
- Trace / screenshot / video 仅在失败时保留，在 `playwright-report/` 和 `test-results/`

## 加新测试

1. `e2e/` 下新建 `NN-name.spec.ts`
2. 从 `./fixtures/daemon` import `test, expect`
3. **选择器集中加在 `helpers/selectors.ts`**，不要在 spec 内写裸 CSS/XPath
4. 复杂 setup 走 `helpers/api.ts` 直接调 REST API（绕过 UI 加速）
5. 跑 `npm run test:e2e -- NN-name.spec.ts` 调试

### 找不到选择器时

1. 用 `npm run test:e2e:ui -- NN-name.spec.ts` 在浏览器里交互定位
2. 或 `npx playwright codegen http://127.0.0.1:18080` 录制后复制选择器到 `selectors.ts`
3. 仍不行可在 React 组件加 `data-testid`，并在 commit message 中标注

### 创建配置

`helpers/api.ts` 的 `api(daemon).createConfig(id, name?, bindPort?)` 通过 REST API 直接创建一份 frps 配置：

- payload 形如 `{id, config: {bindPort, auth, log}, frpsmgr: {name, manualStart}}`
- 默认 `manualStart: true`，避免 fixture daemon 启动时被自动拉起占端口
- `bindPort` 默认 7000，多用例并存请显式指定避免冲突（如 27001/27002）
- 内部用 `helpers/toml.ts` 的 `minimalServerConfig(bindPort)`，只发后端确实接受的 v1.ServerConfig 字段

## 已覆盖场景

| Spec | 验证目标 |
|---|---|
| `01-frps-lifecycle.spec.ts` | 登录 → API 建配置 → UI 看到卡片 → 点启动 → API 确认 started → UI 状态变「正在运行」→ stop → delete → 卡片消失 |
| `02-no-frpc-residue.spec.ts` | 菜单是 "FRPS 实例"（非 FRPC）/ 不应有 "NAT 探测" / 已删的 `/configs/{id}/proxies` 返 404 / 已删的 `/nathole/discover` 返 405 / 新增端点 `/runtime` `/metrics` `/alerts` 存在 |

## 已知约束

- **必须先 build daemon** 才能跑 e2e（globalSetup 校验 `bin/frpsmgrd[-dev].exe` 存在）
- **Windows 杀软**可能拦截 daemon 子进程启动；出现 EPERM/ACCESS_DENIED 把 `bin/` 加入白名单

## 未来扩展

- **CI 集成**：GitHub Actions 加：
  ```yaml
  - run: cd web && npm ci --legacy-peer-deps
  - run: cd web && npx playwright install chromium
  - run: make build-host
  - run: cd web && npm run test:e2e
  - uses: actions/upload-artifact@v4
    if: failure()
    with: { name: playwright-report, path: web/playwright-report }
  ```
- **多浏览器**：`playwright.config.ts` 的 `projects` 段加 firefox / webkit
- **更多场景**：
  - 全参数表单（9 Collapse 分组）每个分组的字段保存往返
  - 原始 TOML 编辑器与可视化表单的一致性
  - Runtime 页：启动 frps → 实例运行后 overview 卡片有 bindPort/curConns
  - Traffic 页：选实例 → 时间范围 → 看曲线（即便是 0）能渲染
  - Alerts 页：建规则 → 触发后事件历史出现

## 故障排查

| 现象 | 原因 / 解决 |
|---|---|
| globalSetup 抛错 "frpsmgrd binary not found" | 先 `make build-host` |
| globalSetup 找到的二进制是**旧版**导致测试失败 | 删旧的 `bin/frpsmgrd-dev.exe` / `bin/frpmgrd.exe`，只留新构建的 `bin/frpsmgrd.exe` |
| Daemon 起不来（5s 超时） | 看 `e2e-tmp/<spec>/daemon.log` 末尾，可能 18080 端口被占 / 杀软拦截 / token env 配错 |
| 选择器找不到（Locator not found） | 用 `npm run test:e2e:ui` 实地探测 + 改 `selectors.ts` |
| `createConfig 400 unknown field` | payload 含上游 v1.ServerConfig 不认的 key（`DisallowUnknownFields`）；核 `helpers/toml.ts` 的 `minimalServerConfig` |
| 卡片状态文案不匹配 | 后端可能用了 `started` 但 UI 文案是「正在运行」；核对 `Configs.tsx` 的 `getStatusBadge` 实现 |
