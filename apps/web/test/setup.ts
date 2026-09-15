/**
 * 组件测试的共享 setup —— **由每个组件测试文件显式 `import "./setup"` 引入**。
 *
 * 为什么不用 vitest 的 `setupFiles` 配置：本仓库是 vite 6 + vitest 2，
 * 二者各自解析到不同版本的 vite 类型，任何 `vitest/config` 的 `defineConfig`
 * 与 `@vitejs/plugin-react` 混用都会在 typecheck 层报版本冲突（运行时其实兼容）。
 * 为避免为此引入 vite/vitest 版本升级，这里退化为「每个组件测试文件显式引入」，
 * 用 `@vitest-environment jsdom` 注释切换环境，效果等价且零配置。
 *
 * 内容：
 * - 注册 jest-dom 匹配器（toBeInTheDocument 等）；
 * - 把 @testing-library/react 的 cleanup 接到 afterEach：本项目不开 vitest
 *   `globals`，RTL 无法依赖全局 afterEach 自动清理，必须显式接线。
 */

import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
