import { defineConfig } from 'vitest/config';

// 单元测试（纯逻辑）：只收 src 下的 *.test.ts，避免把 e2e/ 下的 playwright
// *.spec.ts 也当成 vitest 用例（它们 import @playwright/test，在 vitest 里无法运行）。
// 现有单测仅覆盖纯函数（不含 JSX / DOM），故用 node 环境、不挂 React 插件，跑得最快。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
  },
});
