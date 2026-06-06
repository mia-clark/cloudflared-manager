# 无头浏览器 E2E 测试 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标 (Goal):** 为 frpmgrd 项目搭建基于 Playwright 的无头浏览器 E2E 测试栈，覆盖 5 个关键回归 / 验证场景（登录、创建+启动、STUN 字段回填、多实例日志分流、日志 Clear 语义）。前端 0 改动（除非选择器实在难找需补 `data-testid`）。

**架构 (Architecture):** Playwright 启动 Chromium 无头浏览器，driver 一个已编译的 `frpmgrd-dev.exe` 子进程（同域提供 `web/dist`，模拟生产形态）。每个测试 spec 用 Playwright fixture 获得独立 daemon 实例（独立端口 + TempDir + token），串行运行 (workers=1) 避免端口冲突。Fixture 自动等就绪、cleanup、failure 时保留 daemon 日志和 trace 供事后查。

**技术栈 (Tech Stack):** Playwright (Chromium-only 起步) / TypeScript / Node 20 / 真启 frpmgrd 二进制（不 mock 后端）/ web/e2e/ 代码位置

---

## 前置知识（执行前必读）

### 项目当前状态
- 前端代码在 `web/`，构建产物 `web/dist`，通过 `//go:embed` 嵌进 `frpmgrd` 二进制
- 生产模式：访问 `:8080` 同域，daemon 自服务 web + API
- 默认 token 用 `dev`（与 `make run` 一致）
- 项目根 `Makefile` 里 `make build-host` 会先 build 前端再 build daemon → `bin/frpmgrd-dev.exe`（Windows）或 `bin/frpmgrd`（Linux/macOS）

### 测试时的"假 frps"约定
所有测试用 `serverAddr=127.0.0.1` + `serverPort=65530`（无效端口，永远拒绝连接），加 `loginFailExit=false`。frpc 会持续重连失败，每 ~5s 产生一行 retry 日志 — 这就是日志分流 / Clear 场景需要的"稳定信号源"。

### 资源隔离
- 每个 spec 文件用 `test.use({ daemon })` 拿一个 daemon fixture
- daemon fixture 起一个独立 frpmgrd 子进程，监听 `:18080 + workerIndex`
- TempDir 在 `web/e2e-tmp/<spec-name>-<timestamp>/`，里面有 `profiles/`, `logs/`, `stores/`, `meta.json`, `daemon.log`
- 测试失败时 TempDir **保留**，daemon stdout/stderr 已经追加到 `daemon.log` 供查
- 测试成功时 TempDir 删除（节省磁盘）

### 选择器原则
- 优先 `page.getByRole(...)` / `page.getByLabel(...)` / `page.getByPlaceholder(...)` / `page.getByText(...)` — 语义化、对 UI 文案变更鲁棒
- 集中在 `web/e2e/helpers/selectors.ts`，UI 改了只改这一个文件
- 如果某些 selector 实在难定位（重组件、动态 ID），允许给前端加 `data-testid` —— 但要在 task 注释里写清楚加了哪些

### Windows shell 约束
- 项目 CLAUDE.md 规定：bash 不用 `&&`，用 `;` 或拆开多次 `Bash` 调用
- 编辑器优先 Read / Write / Edit 工具（已经 UTF-8 无 BOM）

### 提交规范
Conventional Commits + 中文描述：
- `chore(e2e)`：基础设施（package.json/config/fixtures/helpers）
- `test(e2e)`：场景测试文件
- `docs(e2e)`：README / 文档

---

## 文件结构概览

```
新建
  web/playwright.config.ts                  # 顶层配置
  web/e2e/globalSetup.ts                    # 检查 daemon 二进制存在
  web/e2e/fixtures/daemon.ts                # daemon fixture (启动 + 等就绪 + cleanup)
  web/e2e/helpers/api.ts                    # 直接调 API 的 helper（绕过 UI 加速 setup）
  web/e2e/helpers/selectors.ts              # 集中页面选择器
  web/e2e/helpers/toml.ts                   # 生成最小 toml 的 helper
  web/e2e/01-login.spec.ts                  # 场景 1
  web/e2e/02-create-and-start.spec.ts       # 场景 2
  web/e2e/03-stun-roundtrip.spec.ts         # 场景 3
  web/e2e/04-log-isolation.spec.ts          # 场景 4
  web/e2e/05-log-clear.spec.ts              # 场景 5
  web/e2e/README.md                         # 开发者文档

修改
  web/package.json                          # 加 @playwright/test devDep + 3 个 npm script
  web/.gitignore                            # 加 e2e-tmp / playwright-report / test-results
```

---

## Task 1: 装 Playwright + 配置 npm scripts

**Files:**
- Modify: `web/package.json`
- Modify: `web/.gitignore`

- [ ] **Step 1.1: 安装 Playwright devDep**

```bash
cd d:/Github_Codes_mia-clark/frp-manager-server/web
npm install --save-dev --legacy-peer-deps @playwright/test@^1.49.0
```

- [ ] **Step 1.2: 编辑 `web/package.json` 加 npm scripts**

在 `scripts` 段加 3 条（保留现有 scripts，不要删）：

```json
"scripts": {
  "dev": "vite",
  "build": "tsc -b && vite build",
  "lint": "eslint .",
  "preview": "vite preview",
  "gen:api": "openapi-typescript ../internal/api/openapi.yaml -o src/api/schema.d.ts",
  "test:e2e:install": "playwright install chromium",
  "test:e2e": "playwright test",
  "test:e2e:ui": "playwright test --ui",
  "test:e2e:report": "playwright show-report"
}
```

- [ ] **Step 1.3: 编辑 `web/.gitignore` 加 e2e 产物**

在 `web/.gitignore` 末尾追加（不要删现有内容）：

```
# E2E test artifacts
e2e-tmp/
playwright-report/
test-results/
.playwright/
```

- [ ] **Step 1.4: 安装 Chromium 浏览器**

```bash
cd d:/Github_Codes_mia-clark/frp-manager-server/web
npx playwright install chromium
```

确认输出包含 `chromium ... downloaded` 或 `up to date`。

- [ ] **Step 1.5: 提交**

```bash
cd d:/Github_Codes_mia-clark/frp-manager-server
git add web/package.json web/package-lock.json web/.gitignore
git commit -m "chore(e2e): 安装 Playwright 并注册 npm scripts"
```

---

## Task 2: globalSetup 校验 daemon 二进制存在

**Files:**
- Create: `web/e2e/globalSetup.ts`

- [ ] **Step 2.1: 写 globalSetup 文件**

`web/e2e/globalSetup.ts`:

```ts
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Playwright globalSetup — 在所有 worker 启动前调用一次。
 *
 * 职责：
 *   1. 检查项目根下 bin/frpmgrd-dev[.exe] 是否存在。不在就抛错让用户先 build。
 *
 * 不在职责内：
 *   - 主动构建 daemon（避免每次跑测都触发昂贵的 Go 编译）
 *   - 启动 daemon（那是每个 spec 的 daemon fixture 干的事）
 */
export default async function globalSetup() {
  const projectRoot = resolve(__dirname, '..', '..');
  const candidates = [
    resolve(projectRoot, 'bin', 'frpmgrd-dev.exe'),
    resolve(projectRoot, 'bin', 'frpmgrd-dev'),
    resolve(projectRoot, 'bin', 'frpmgrd.exe'),
    resolve(projectRoot, 'bin', 'frpmgrd'),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `frpmgrd binary not found at any of:\n  ${candidates.join('\n  ')}\n` +
        `Run \`make build-host\` (or \`cd web && npm run build; cd .. && go build -o bin/frpmgrd-dev.exe ./cmd/frpmgrd\`) first.`,
    );
  }
  // 把找到的路径塞到环境变量里，daemon fixture 读
  process.env.FRPMGRD_BIN = found;
  // eslint-disable-next-line no-console
  console.log(`[globalSetup] frpmgrd binary: ${found}`);
}
```

- [ ] **Step 2.2: 提交（先单独提交一个空 commit 占位 — 真正测试在 Task 3 完成后）**

不需要单独 commit；与 Task 3 一起提交即可。跳到 Task 3。

---

## Task 3: daemon fixture

**Files:**
- Create: `web/e2e/fixtures/daemon.ts`

- [ ] **Step 3.1: 写 daemon fixture**

`web/e2e/fixtures/daemon.ts`:

```ts
import { test as base } from '@playwright/test';
import { spawn, ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export type Daemon = {
  /** 完整 base URL，含端口，例: http://127.0.0.1:18080 */
  baseURL: string;
  /** API token */
  token: string;
  /** TempDir 绝对路径（成功时 cleanup，失败时保留） */
  dataDir: string;
  /** daemon.log 文件路径 */
  logPath: string;
};

type Fixtures = {
  daemon: Daemon;
};

/**
 * 拓展 Playwright base test，注入 `daemon` fixture。
 *
 * 每个 worker 启动时：
 *   1. 创建独立 TempDir
 *   2. 起一个 frpmgrd 子进程，监听 :18080+workerIndex
 *   3. 轮询 GET /api/v1/version 直到 200 (max 5s)
 *   4. 在 fixture scope 内提供 baseURL / token
 *   5. 测试结束（成功）→ kill daemon + rm TempDir
 *   6. 测试失败 → kill daemon + 保留 TempDir，路径附到测试报告
 */
export const test = base.extend<{}, Fixtures>({
  daemon: [
    async ({}, use, workerInfo) => {
      const bin = process.env.FRPMGRD_BIN;
      if (!bin || !existsSync(bin)) {
        throw new Error(
          `FRPMGRD_BIN not set or not exists (${bin}). globalSetup should have set it.`,
        );
      }

      const port = 18080 + workerInfo.workerIndex;
      const token = 'e2e-token-' + workerInfo.workerIndex;
      const e2eTmpRoot = resolve(__dirname, '..', '..', 'e2e-tmp');
      // mkdtemp 返回带后缀的实际路径
      const dataDir = mkdtempSync(join(e2eTmpRoot, `w${workerInfo.workerIndex}-`));
      const logPath = join(dataDir, 'daemon.log');
      const logStream = createWriteStream(logPath, { flags: 'a' });

      const proc: ChildProcess = spawn(bin, ['serve'], {
        env: {
          ...process.env,
          FRPMGR_API_TOKEN: token,
          FRPMGR_HTTP_ADDR: `:${port}`,
          FRPMGR_DATA_DIR: dataDir,
          FRPMGR_LOG_LEVEL: 'info',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.stdout?.pipe(logStream);
      proc.stderr?.pipe(logStream);

      const baseURL = `http://127.0.0.1:${port}`;
      // 等就绪
      const ready = await waitForReady(baseURL, 5000);
      if (!ready) {
        proc.kill('SIGKILL');
        throw new Error(
          `daemon did not become ready in 5s on ${baseURL}. logs:\n${tail(logPath, 50)}`,
        );
      }

      let testFailed = false;
      try {
        await use({ baseURL, token, dataDir, logPath });
      } catch (e) {
        testFailed = true;
        throw e;
      } finally {
        proc.kill('SIGTERM');
        await delay(500);
        if (proc.exitCode == null) proc.kill('SIGKILL');
        logStream.end();
        // Playwright 把 worker-level test failure 传播过来；我们用 workerInfo.errors 判定
        const anyFailed = testFailed || (workerInfo.errors?.length ?? 0) > 0;
        if (!anyFailed) {
          rmSync(dataDir, { recursive: true, force: true });
        } else {
          // eslint-disable-next-line no-console
          console.log(`[daemon fixture] preserving ${dataDir} for inspection`);
        }
      }
    },
    { scope: 'worker' },
  ],
});

async function waitForReady(baseURL: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseURL}/api/v1/version`);
      if (r.ok) return true;
    } catch {
      // ignore, retry
    }
    await delay(100);
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function tail(path: string, lines: number): string {
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    const data = fs.readFileSync(path, 'utf8');
    const arr = data.split(/\r?\n/);
    return arr.slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

export { expect } from '@playwright/test';
```

- [ ] **Step 3.2: 确保 `web/e2e-tmp/` 目录存在（mkdtempSync 要求父目录存在）**

通过添加一个简短的初始化语句：在 `daemon.ts` 顶部或 globalSetup 里 ensure 目录存在。**改 globalSetup.ts**：在 `process.env.FRPMGRD_BIN = found;` 行之后追加：

```ts
import { mkdirSync } from 'node:fs';
// ...
const e2eTmp = resolve(__dirname, '..', 'e2e-tmp');
mkdirSync(e2eTmp, { recursive: true });
```

- [ ] **Step 3.3: 暂不跑测试（还没 spec 文件）**

跳到 Task 4。

---

## Task 4: API helper + selectors + toml helper

**Files:**
- Create: `web/e2e/helpers/api.ts`
- Create: `web/e2e/helpers/selectors.ts`
- Create: `web/e2e/helpers/toml.ts`

- [ ] **Step 4.1: 写 `web/e2e/helpers/toml.ts`**

```ts
/**
 * 生成最小可用 ClientConfigV1 JSON（不是 toml 字符串 — 后端 POST 接 JSON）。
 * 每个 instance 都默认指向 127.0.0.1:65530 这个永远拒绝连接的端口，
 * 配合 loginFailExit=false 让 frpc 持续重连，从而产生稳定的日志流供测试用。
 */
export function minimalConfig(name: string) {
  return {
    serverAddr: '127.0.0.1',
    serverPort: 65530,
    loginFailExit: false,
    log: { level: 'info', maxDays: 1 },
    frpmgr: { name },
  };
}
```

- [ ] **Step 4.2: 写 `web/e2e/helpers/api.ts`**

```ts
import type { Daemon } from '../fixtures/daemon';
import { minimalConfig } from './toml';

/**
 * 直接调 daemon REST API 的 helper。用于在测试中快速 setup 状态
 * （绕过 UI 加速，UI 自己的交互由 spec 内的 page actions 测）。
 */
export function api(daemon: Daemon) {
  const h = { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' };

  return {
    async createConfig(id: string) {
      const r = await fetch(`${daemon.baseURL}/api/v1/configs`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ id, config: minimalConfig(id) }),
      });
      if (!r.ok) throw new Error(`createConfig(${id}) failed: ${r.status} ${await r.text()}`);
    },

    async start(id: string) {
      const r = await fetch(`${daemon.baseURL}/api/v1/configs/${id}/start`, {
        method: 'POST',
        headers: h,
      });
      if (!r.ok) throw new Error(`start(${id}) failed: ${r.status} ${await r.text()}`);
    },

    async stop(id: string) {
      const r = await fetch(`${daemon.baseURL}/api/v1/configs/${id}/stop`, {
        method: 'POST',
        headers: h,
      });
      if (!r.ok) throw new Error(`stop(${id}) failed: ${r.status} ${await r.text()}`);
    },

    async getLogs(id: string, lines = 100): Promise<string[]> {
      const r = await fetch(
        `${daemon.baseURL}/api/v1/configs/${id}/logs?lines=${lines}`,
        { headers: h },
      );
      if (!r.ok) throw new Error(`getLogs(${id}) failed: ${r.status}`);
      const body = (await r.json()) as { lines: string[] };
      return body.lines ?? [];
    },

    async clearLogs(id: string) {
      const r = await fetch(`${daemon.baseURL}/api/v1/configs/${id}/logs`, {
        method: 'DELETE',
        headers: h,
      });
      if (!r.ok) throw new Error(`clearLogs(${id}) failed: ${r.status}`);
    },

    /** 轮询 GET /logs 直到 id 至少累积 N 行，超时抛错。 */
    async waitForLogLines(id: string, atLeast: number, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const lines = await this.getLogs(id, atLeast * 2);
        if (lines.length >= atLeast) return lines;
        await new Promise((res) => setTimeout(res, 500));
      }
      throw new Error(`waitForLogLines(${id}, ${atLeast}) timed out`);
    },
  };
}
```

- [ ] **Step 4.3: 写 `web/e2e/helpers/selectors.ts`**

> 注意：本文件含初版选择器猜测。场景 implementer 第一次跑测试时若发现某条 selector 找不到，应该：
> 1. 用 `npx playwright codegen http://127.0.0.1:18080` 实地探测页面 DOM
> 2. 优先用 `getByRole` / `getByLabel` / `getByPlaceholder` / `getByText`
> 3. 如果业务组件没语义化标签，可以给前端组件加 `data-testid`，**但要在 commit message 里写清楚加了哪个 data-testid**

```ts
import type { Page, Locator } from '@playwright/test';

export const login = {
  tokenInput: (p: Page): Locator => p.getByPlaceholder(/api token|token/i),
  submitBtn: (p: Page): Locator => p.getByRole('button', { name: /登录|login|sign in/i }),
  errorMsg: (p: Page): Locator => p.getByText(/无效|invalid|失败|failed/i),
};

export const sidebar = {
  frpcInstancesItem: (p: Page): Locator => p.getByRole('menuitem', { name: /FRPC 实例|实例/i }),
  dashboardItem: (p: Page): Locator => p.getByRole('menuitem', { name: /仪表盘|dashboard/i }),
};

export const configList = {
  newConfigBtn: (p: Page): Locator => p.getByRole('button', { name: /新建配置|新建|add|create/i }),
  configCard: (p: Page, id: string): Locator =>
    p.locator(`text=ID: ${id}`).locator('xpath=ancestor::*[contains(@class,"config")][1]'),
  startBtn: (card: Locator): Locator => card.getByRole('button', { name: /启动|start/i }),
  stopBtn: (card: Locator): Locator => card.getByRole('button', { name: /停止|stop/i }),
  stateBadge: (card: Locator): Locator =>
    card.locator('text=/正在运行|未启动|started|stopped/i'),
};

export const detailTabs = {
  proxies: (p: Page): Locator => p.getByRole('tab', { name: /代理穿透规则|代理|proxies/i }),
  visualConfig: (p: Page): Locator => p.getByRole('tab', { name: /常规配置|可视化|visual/i }),
  toml: (p: Page): Locator => p.getByRole('tab', { name: /高级 TOML|toml/i }),
  logs: (p: Page): Locator => p.getByRole('tab', { name: /运行日志速览|日志/i }),
};

export const visualConfig = {
  stunInput: (p: Page): Locator => p.getByLabel(/STUN 服务地址|stun/i),
  saveBtn: (p: Page): Locator => p.getByRole('button', { name: /保存全部客户端配置|保存/i }),
  saveOkToast: (p: Page): Locator => p.getByText(/保存成功|saved/i),
};

export const logsView = {
  /** 单行日志容器；index.css 里的 .log-line 是项目实际使用的 class */
  lines: (p: Page): Locator => p.locator('.log-line'),
  clearBtn: (p: Page): Locator => p.getByRole('button', { name: /清空|clear/i }),
  /** 清空确认弹窗的确认按钮（如有） */
  confirmClearBtn: (p: Page): Locator =>
    p.getByRole('button', { name: /^确定$|^确认$|^ok$/i }),
};
```

- [ ] **Step 4.4: 跑 tsc 验证类型**

```bash
cd d:/Github_Codes_mia-clark/frp-manager-server/web
npx tsc --noEmit -p tsconfig.json 2>&1 | head -30
```

Playwright tests 通常不在 tsconfig include 里，可能没被 type-check。这是 Task 1 装 Playwright 时它会自动创建 tsconfig 给 e2e。如果上面没问题就 OK。

- [ ] **Step 4.5: 创建 playwright.config.ts**

`web/playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60 * 1000,
  expect: { timeout: 10 * 1000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/globalSetup.ts',
  use: {
    actionTimeout: 10 * 1000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 1440, height: 900 },
        headless: true,
      },
    },
  ],
});
```

- [ ] **Step 4.6: 提交基础设施**

```bash
cd d:/Github_Codes_mia-clark/frp-manager-server
git add web/playwright.config.ts web/e2e/globalSetup.ts web/e2e/fixtures/ web/e2e/helpers/
git commit -m "chore(e2e): 搭建 Playwright 基础设施 (config + daemon fixture + helpers)"
```

---

## Task 5: 场景 1 — 登录流程

**Files:**
- Create: `web/e2e/01-login.spec.ts`

- [ ] **Step 5.1: 写测试**

```ts
import { test, expect } from './fixtures/daemon';
import { login } from './helpers/selectors';

test.describe('登录流程', () => {
  test('正确 token 可登录到 dashboard', async ({ page, daemon }) => {
    await page.goto(daemon.baseURL);
    // 应该自动跳到 /login 或显示登录表单
    await expect(login.tokenInput(page)).toBeVisible();

    await login.tokenInput(page).fill(daemon.token);
    await login.submitBtn(page).click();

    // 登录成功后 URL 应该不在 /login，且能看到主导航
    await expect(page).not.toHaveURL(/login/);
    // 通过看到任意一个导航项验证 dashboard 已加载
    await expect(page.getByRole('menuitem', { name: /FRPC 实例|实例|仪表盘/i }).first()).toBeVisible();
  });

  test('错误 token 应显示错误并停在登录页', async ({ page, daemon }) => {
    await page.goto(daemon.baseURL);
    await login.tokenInput(page).fill('wrong-token');
    await login.submitBtn(page).click();

    // 还在登录页或显示错误提示
    await expect(login.tokenInput(page)).toBeVisible();
  });
});
```

- [ ] **Step 5.2: 跑测试**

```bash
cd d:/Github_Codes_mia-clark/frp-manager-server/web
npm run test:e2e -- 01-login.spec.ts 2>&1 | tail -40
```

预期：两个测试都 PASS（或第一次因 selector 不对失败 — 这种时候应跑 `npx playwright codegen http://127.0.0.1:18080` 实地探测选择器）。

如果 selector 错了，调整 `selectors.ts` 里的 `login` 段（不要在 spec 文件内改），再跑。

- [ ] **Step 5.3: 提交**

```bash
cd d:/Github_Codes_mia-clark/frp-manager-server
git add web/e2e/01-login.spec.ts web/e2e/helpers/selectors.ts
git commit -m "test(e2e): 场景 1 登录流程"
```

---

## Task 6: 场景 2 — 创建配置 + 启动

**Files:**
- Create: `web/e2e/02-create-and-start.spec.ts`

- [ ] **Step 6.1: 写测试**

```ts
import { test, expect } from './fixtures/daemon';
import { api } from './helpers/api';
import { login, sidebar, configList } from './helpers/selectors';

test.describe('创建配置 + 启动', () => {
  test('通过 API 创建实例后, UI 应显示该实例并能启动到 started 状态', async ({ page, daemon }) => {
    // setup via API (UI 创建流程很多组件，本场景目标是验证启动)
    await api(daemon).createConfig('inst_a');

    // login + 进 FRPC 实例页
    await page.goto(daemon.baseURL);
    await login.tokenInput(page).fill(daemon.token);
    await login.submitBtn(page).click();
    await sidebar.frpcInstancesItem(page).click();

    const card = configList.configCard(page, 'inst_a');
    await expect(card).toBeVisible();

    // 启动
    await configList.startBtn(card).click();

    // 状态变为"正在运行"（最多等 8s）
    await expect(configList.stateBadge(card)).toContainText(/正在运行|started/i, {
      timeout: 8000,
    });
  });
});
```

- [ ] **Step 6.2: 跑测试**

```bash
cd d:/Github_Codes_mia-clark/frp-manager-server/web
npm run test:e2e -- 02-create-and-start.spec.ts 2>&1 | tail -40
```

可能 selector 还要调。**如果 `configList.configCard` 这个 XPath ancestor 写法找不到卡片，改成简单 `.locator('.ant-card', { hasText: id })` 之类**。

- [ ] **Step 6.3: 提交**

```bash
cd d:/Github_Codes_mia-clark/frp-manager-server
git add web/e2e/02-create-and-start.spec.ts web/e2e/helpers/selectors.ts
git commit -m "test(e2e): 场景 2 创建 + 启动实例"
```

---

## Task 7: 场景 3 — STUN 字段回填回归

**Files:**
- Create: `web/e2e/03-stun-roundtrip.spec.ts`

这条测试是上次"STUN 字段大小写"bug（feat/frpc-logs-isolation 之前修过）的回归保险。

- [ ] **Step 7.1: 写测试**

```ts
import { test, expect } from './fixtures/daemon';
import { api } from './helpers/api';
import { login, sidebar, configList, detailTabs, visualConfig } from './helpers/selectors';

test.describe('STUN 字段回填回归', () => {
  test('保存 STUN 后刷新页面, 输入框仍应显示填入的值', async ({ page, daemon }) => {
    await api(daemon).createConfig('inst_stun');

    await page.goto(daemon.baseURL);
    await login.tokenInput(page).fill(daemon.token);
    await login.submitBtn(page).click();
    await sidebar.frpcInstancesItem(page).click();

    const card = configList.configCard(page, 'inst_stun');
    await card.click(); // 选中

    // 进入「常规配置」tab
    await detailTabs.visualConfig(page).click();

    // 填 STUN 并保存
    const stunValue = 'stun.cloudflare.com:3478';
    await visualConfig.stunInput(page).fill(stunValue);
    await visualConfig.saveBtn(page).click();

    // 等 toast / 保存成功提示
    await expect(visualConfig.saveOkToast(page)).toBeVisible({ timeout: 5000 });

    // 关键回归点：刷新页面后回填
    await page.reload();
    // 重新登录（如果 token 不持久化的话）— 项目用 localStorage, 应该保留
    // 直接重新进入 FRPC 实例 + 该 card + 常规配置
    await sidebar.frpcInstancesItem(page).click();
    await configList.configCard(page, 'inst_stun').click();
    await detailTabs.visualConfig(page).click();

    // 验证字段仍是 stunValue（这是 bug 当时的具体表现：保存后看似成功, 但刷新后空白）
    await expect(visualConfig.stunInput(page)).toHaveValue(stunValue);
  });
});
```

- [ ] **Step 7.2: 跑测试**

```bash
cd d:/Github_Codes_mia-clark/frp-manager-server/web
npm run test:e2e -- 03-stun-roundtrip.spec.ts 2>&1 | tail -40
```

- [ ] **Step 7.3: 提交**

```bash
cd d:/Github_Codes_mia-clark/frp-manager-server
git add web/e2e/03-stun-roundtrip.spec.ts web/e2e/helpers/selectors.ts
git commit -m "test(e2e): 场景 3 STUN 字段回填回归"
```

---

## Task 8: 场景 4 — 多实例日志分流

**Files:**
- Create: `web/e2e/04-log-isolation.spec.ts`

- [ ] **Step 8.1: 写测试**

```ts
import { test, expect } from './fixtures/daemon';
import { api } from './helpers/api';
import { login, sidebar, configList, detailTabs, logsView } from './helpers/selectors';

test.describe('多实例日志严格分流', () => {
  test('inst_a 的日志视图只显示 [inst=inst_a] 行, inst_b 同理', async ({ page, daemon }) => {
    const a = api(daemon);

    // setup: 创建 2 实例 + 启动 + 等积累日志
    await a.createConfig('inst_a');
    await a.createConfig('inst_b');
    await a.start('inst_a');
    await a.start('inst_b');
    await a.waitForLogLines('inst_a', 3, 30000);
    await a.waitForLogLines('inst_b', 3, 30000);

    // 通过 UI 验证分流
    await page.goto(daemon.baseURL);
    await login.tokenInput(page).fill(daemon.token);
    await login.submitBtn(page).click();
    await sidebar.frpcInstancesItem(page).click();

    // 选 inst_a
    await configList.configCard(page, 'inst_a').click();
    await detailTabs.logs(page).click();
    // 等至少一行出现
    await expect(logsView.lines(page).first()).toBeVisible({ timeout: 10000 });

    const linesA = await logsView.lines(page).allTextContents();
    expect(linesA.length).toBeGreaterThan(0);
    for (const line of linesA) {
      expect(line, `inst_a view leaked: ${line}`).toContain('[inst=inst_a]');
      expect(line, `inst_a view leaked: ${line}`).not.toContain('[inst=inst_b]');
    }

    // 切到 inst_b
    await configList.configCard(page, 'inst_b').click();
    await detailTabs.logs(page).click();
    await expect(logsView.lines(page).first()).toBeVisible({ timeout: 10000 });

    const linesB = await logsView.lines(page).allTextContents();
    expect(linesB.length).toBeGreaterThan(0);
    for (const line of linesB) {
      expect(line, `inst_b view leaked: ${line}`).toContain('[inst=inst_b]');
      expect(line, `inst_b view leaked: ${line}`).not.toContain('[inst=inst_a]');
    }
  });
});
```

- [ ] **Step 8.2: 跑测试**

```bash
cd d:/Github_Codes_mia-clark/frp-manager-server/web
npm run test:e2e -- 04-log-isolation.spec.ts 2>&1 | tail -50
```

⚠️ 注意：当前 `main` 分支还没有 frpc 日志隔离的代码（那个 feature 分支没合）。所以这个测试在 main 分支上会失败（这正是 bug 的复现）。

**重要**：在 implementer 跑这个测试前，先 `git merge feature/frpc-logs-isolation --no-edit`（合并日志隔离 feature 分支）。Implementer 应在 Task 8 开始时执行：

```bash
cd d:/Github_Codes_mia-clark/frp-manager-server
git merge --no-ff feature/frpc-logs-isolation -m "merge: 合并 frpc 日志隔离 feature 以让 E2E 场景 4-5 能跑通"
# 重新 build daemon（合并带来新代码）
make build-host || (cd web && npm run build; cd .. && go build -o bin/frpmgrd-dev.exe ./cmd/frpmgrd)
```

合并后再跑 Task 8 测试。

- [ ] **Step 8.3: 提交**

```bash
cd d:/Github_Codes_mia-clark/frp-manager-server
git add web/e2e/04-log-isolation.spec.ts web/e2e/helpers/selectors.ts
git commit -m "test(e2e): 场景 4 多实例日志严格分流"
```

---

## Task 9: 场景 5 — Clear 语义

**Files:**
- Create: `web/e2e/05-log-clear.spec.ts`

- [ ] **Step 9.1: 写测试**

```ts
import { test, expect } from './fixtures/daemon';
import { api } from './helpers/api';
import { login, sidebar, configList, detailTabs, logsView } from './helpers/selectors';

test.describe('日志 Clear 仅清空本实例视图, 不影响其他实例', () => {
  test('清空 inst_a 视图后 inst_b 日志依然完整', async ({ page, daemon }) => {
    const a = api(daemon);

    await a.createConfig('inst_a');
    await a.createConfig('inst_b');
    await a.start('inst_a');
    await a.start('inst_b');
    await a.waitForLogLines('inst_a', 3, 30000);
    await a.waitForLogLines('inst_b', 3, 30000);

    await page.goto(daemon.baseURL);
    await login.tokenInput(page).fill(daemon.token);
    await login.submitBtn(page).click();
    await sidebar.frpcInstancesItem(page).click();

    // 选 inst_a 进日志页
    await configList.configCard(page, 'inst_a').click();
    await detailTabs.logs(page).click();
    await expect(logsView.lines(page).first()).toBeVisible({ timeout: 10000 });

    // 清空
    await logsView.clearBtn(page).click();
    // 如有确认弹窗
    const confirmBtn = logsView.confirmClearBtn(page);
    if (await confirmBtn.isVisible().catch(() => false)) {
      await confirmBtn.click();
    }

    // 等清空生效（前端逻辑可能瞬间清, 也可能等下次 WS 推送; 给 3s 余地）
    await page.waitForTimeout(2000);

    // 验证：UI 上 inst_a 的旧行已经看不见 (新行可能因 frpc 持续重试又冒出来, 但都应是 Clear 之后产生的)
    // 简化断言：当前显示行数应该 <= 几条（不是几十条旧行那么多）
    const remainingA = await logsView.lines(page).count();
    // Clear 后 2s 内, 5s 重试间隔下应该 ≤ 1 行
    expect(remainingA).toBeLessThanOrEqual(2);

    // 切到 inst_b：仍能看到完整历史日志
    await configList.configCard(page, 'inst_b').click();
    await detailTabs.logs(page).click();
    await expect(logsView.lines(page).first()).toBeVisible({ timeout: 10000 });
    const linesB = await logsView.lines(page).count();
    expect(linesB).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 9.2: 跑测试**

```bash
cd d:/Github_Codes_mia-clark/frp-manager-server/web
npm run test:e2e -- 05-log-clear.spec.ts 2>&1 | tail -50
```

- [ ] **Step 9.3: 提交**

```bash
cd d:/Github_Codes_mia-clark/frp-manager-server
git add web/e2e/05-log-clear.spec.ts web/e2e/helpers/selectors.ts
git commit -m "test(e2e): 场景 5 日志 Clear 仅清空本实例视图"
```

---

## Task 10: 跑全部测试一次 + 写开发者文档

**Files:**
- Create: `web/e2e/README.md`

- [ ] **Step 10.1: 跑完整 e2e suite**

```bash
cd d:/Github_Codes_mia-clark/frp-manager-server/web
npm run test:e2e 2>&1 | tail -30
```

预期：5 个 spec 全 PASS（共 6 个测试，因为 01-login 有 2 个 test case）。

如有 fail，根据 `playwright-report/index.html` 里的 trace + screenshot + daemon.log 定位修复，重跑直到全绿。

- [ ] **Step 10.2: 写 `web/e2e/README.md`**

```markdown
# E2E Tests

基于 Playwright 的端到端测试，覆盖 frpmgrd UI 的关键回归 / 验证路径。

## 前置

- Node 20+
- 项目已经构建出 daemon 二进制：

```bash
make build-host
# 或
cd web && npm run build
cd .. && go build -o bin/frpmgrd-dev.exe ./cmd/frpmgrd
```

## 首次安装浏览器

```bash
cd web
npm run test:e2e:install
```

## 跑测试

```bash
cd web
npm run test:e2e            # 无头运行
npm run test:e2e:ui         # Playwright UI 模式，方便调试
npm run test:e2e:report     # 跑完后看 HTML 报告
```

## 架构

- 每个 spec 自带一个 daemon fixture（`fixtures/daemon.ts`），起独立 frpmgrd 子进程，监听独立端口 + 独立 TempDir
- 串行运行（`workers: 1`）避免端口冲突
- 失败时 daemon 的 stdout/stderr 落地到 `e2e-tmp/<spec>/daemon.log`，trace + screenshot + video 在 `playwright-report/` 和 `test-results/`
- 成功时 TempDir 自动删除；失败时保留供事后查

## 加新测试

1. 在 `e2e/` 下新建 `NN-name.spec.ts`
2. 从 `./fixtures/daemon` import `test, expect`
3. 选择器集中加在 `helpers/selectors.ts`，不要在 spec 文件内写裸 CSS / XPath
4. 复杂 setup 走 `helpers/api.ts` 直接调 REST API（绕过 UI 加速）
5. 跑 `npm run test:e2e -- NN-name.spec.ts` 调试

## 已覆盖场景

| # | Spec | 验证目标 |
|---|---|---|
| 1 | `01-login.spec.ts` | 登录正确/错误 token |
| 2 | `02-create-and-start.spec.ts` | 创建实例 + 启动到 started |
| 3 | `03-stun-roundtrip.spec.ts` | STUN 字段保存后刷新仍显示（回归） |
| 4 | `04-log-isolation.spec.ts` | 多实例日志按 `[inst=<id>]` 严格分流 |
| 5 | `05-log-clear.spec.ts` | Clear 仅清空本实例视图，其他实例不受影响 |

## 未来扩展

- CI 集成：GitHub Actions 加 `npm run test:e2e:install && make build-host && cd web && npm run test:e2e` 一句即可
- 多浏览器：在 `playwright.config.ts` `projects` 段加 firefox / webkit
- Visual regression：用 `expect(page).toHaveScreenshot()`
```

- [ ] **Step 10.3: 提交**

```bash
cd d:/Github_Codes_mia-clark/frp-manager-server
git add web/e2e/README.md
git commit -m "docs(e2e): 开发者文档 + 已覆盖场景列表"
```

---

## Self-Review

**Spec 覆盖核对（用户选的 5 场景）：**

| 场景 | Task |
|---|---|
| 1. 登录流程 | Task 5 |
| 2. 创建配置 + 启动 | Task 6 |
| 3. STUN 字段回填 | Task 7 |
| 4. 多实例日志分流 | Task 8 |
| 5. 日志 Clear 语义 | Task 9 |

**Placeholder 扫描：** 无 "TBD" / "TODO 待补"。选择器有"如果找不到就用 codegen"的回退路径，且明确允许加 data-testid（写在 commit message 里）。

**类型一致性：**
- `Daemon` type 在 fixtures/daemon.ts 定义并在 helpers/api.ts 引用 — 一致
- `api(daemon)` 工厂返回 object，被 5 个 spec 引用 — 一致
- selectors 命名空间（login / sidebar / configList / detailTabs / visualConfig / logsView）跨多 spec 引用 — 集中在 selectors.ts

**风险提示：**
- 场景 4/5 依赖 `feature/frpc-logs-isolation` 分支的代码。Task 8 头会先 merge 那条分支。如果合并冲突（不应该有，文件不重叠），implementer 应 NEEDS_CONTEXT 回报。
- 选择器是按对前端 UI 的"合理猜测"写的，第一次跑可能多处需要 codegen 调整。这是预期的，实施时应预留调整时间。
- Windows 上 frpmgrd 启动可能被杀软拦截。如果 spawn 失败说 EPERM/ACCESS_DENIED，让用户在杀软白名单加 bin/ 目录。

---

## 执行交接

实施这份 plan，使用 **superpowers:subagent-driven-development** —— 每个 Task 派 fresh subagent，subagent 自己跑测试 + 调试 + 提交。
