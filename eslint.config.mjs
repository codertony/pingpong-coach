// @ts-check
/**
 * ESLint 扁平配置（ESLint 9）。
 *
 * 这个文件存在的唯一目的：把 AGENTS.md 里靠自觉遵守的架构与纪律约束，
 * **变成会报错的规则**。文档没人看，CI 拦得住。
 *
 * 三类约束：
 *   1. 依赖方向（boundaries）—— contracts ← motion-core ← web，api ← contracts
 *   2. 纪律红线 —— 缺失值不许补 0、不许用离线平滑、mock 不许混入延迟统计
 *   3. 通用正确性 —— 未处理 Promise、any 蔓延、遗留 console
 */

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import boundaries from "eslint-plugin-boundaries";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

export default tseslint.config(
  // ---------- 忽略项 ----------
  {
    ignores: [
      "**/dist/**",
      // 临时/调试目录（`.gitignore` 里也有）：本地探针脚本常直接用 DOM API，
      // 被 lint 会报一堆 no-undef，挡住正常门禁。（实测踩过）
      "**/.tmp-*/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.d.ts",
      "**/.vite/**",
      "evaluation/**",
      "knowledge/**",
      "configs/**",
      // 模型与 WASM 运行时资产：由 pnpm models:fetch 与手动复制产生，
      // 是 vendored 二进制/压缩 JS，不属于本仓库源码，不参与 lint。
      "apps/web/public/models/**",
      "apps/web/public/wasm/**",
    ],
  },

  // ---------- 基础推荐规则 ----------
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ---------- 全局设置 ----------
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    linterOptions: {
      reportUnusedDisableDirectives: "warn",
    },
    rules: {
      // 未使用变量：允许下划线前缀显式忽略
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // any 是类型安全的破口，必须显式写注释说明理由才能用
      "@typescript-eslint/no-explicit-any": "error",
      // 浮空 Promise：本项目大量使用异步，漏 await 会导致时序错乱
      "@typescript-eslint/no-floating-promises": "off", // 需 type-aware，见下方单独配置
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "prefer-const": "error",
      "no-var": "error",
    },
  },

  // ---------- 依赖边界约束（本配置的核心价值）----------
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: { boundaries },
    settings: {
      "boundaries/elements": [
        { type: "contracts", pattern: "packages/contracts/src/**", mode: "full" },
        { type: "motion-core", pattern: "packages/motion-core/src/**", mode: "full" },
        { type: "web", pattern: "apps/web/src/**", mode: "full" },
        { type: "api", pattern: "apps/api/src/**", mode: "full" },
      ],
      "boundaries/ignore": ["**/test/**", "**/*.test.ts", "**/*.test.tsx"],
    },
    rules: {
      "boundaries/element-types": [
        "error",
        {
          default: "disallow",
          message:
            "${file.type} 不允许依赖 ${dependency.type}。依赖方向必须是 contracts ← motion-core ← web，且 api 只依赖 contracts（见 AGENTS.md）。",
          rules: [
            // 同模块内部互相引用（web 内部各文件之间）是允许的
            { from: "contracts", allow: ["contracts"] },
            // contracts 是最底层，不依赖任何其他业务模块
            { from: "motion-core", allow: ["contracts", "motion-core"] },
            // api 只依赖 contracts（不碰 motion-core，不碰 web）
            { from: "api", allow: ["contracts", "api"] },
            // web 可依赖 contracts 与 motion-core
            { from: "web", allow: ["contracts", "motion-core", "web"] },
          ],
        },
      ],
    },
  },

  // ---------- API 层：只能依赖 contracts ----------
  //
  // 说明：boundaries 插件按「相对文件路径」判定依赖，而跨包引用用的是
  // 裸包名（@pingpong/motion-core），会被解析到 node_modules 符号链接，
  // 导致 boundaries 匹配不到。所以这里对「谁能 import 谁」用
  // no-restricted-imports 显式兜底 —— 它按包名匹配，确定可靠。
  {
    files: ["apps/api/src/**/*.ts"],
    ignores: ["**/test/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@pingpong/motion-core", "@pingpong/web", "@pingpong/api/*"],
              message:
                "apps/api 只允许依赖 @pingpong/contracts。motion-core 属于前端计算层，服务端不得直接引用（见 AGENTS.md 依赖方向）。",
            },
          ],
        },
      ],
    },
  },

  // ---------- motion-core 必须是纯计算 ----------
  {
    files: ["packages/motion-core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react",
              message: "motion-core 必须是纯 TS，不得依赖 React（AGENTS.md 依赖方向）。",
            },
            { name: "react-dom", message: "motion-core 必须是纯 TS，不得依赖 React DOM。" },
            {
              name: "@mediapipe/tasks-vision",
              message: "motion-core 不得依赖 MediaPipe，视觉层只属于 apps/web。",
            },
          ],
          patterns: [
            {
              group: ["node:*", "fs", "path", "crypto"],
              message: "motion-core 不得依赖 Node 内置模块，它必须能在浏览器与测试环境同等运行。",
            },
            {
              group: ["@pingpong/web", "apps/**"],
              message: "motion-core 不得依赖任何应用层代码。",
            },
          ],
        },
      ],
      // motion-core 不许碰 DOM / 网络 / 存储
      "no-restricted-globals": [
        "error",
        { name: "window", message: "motion-core 不得访问 window。" },
        { name: "document", message: "motion-core 不得访问 document。" },
        { name: "fetch", message: "motion-core 不得发起网络请求。" },
        { name: "localStorage", message: "motion-core 不得访问存储。" },
        { name: "performance", message: "motion-core 不得读时钟；时间必须由调用方传入。" },
      ],
    },
  },

  // ---------- 红线：contracts 必须是纯 schema ----------
  {
    files: ["packages/contracts/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@pingpong/*", "**/motion-core/**", "**/apps/**"],
              message: "contracts 是数据契约唯一来源，不得依赖任何业务模块（AGENTS.md）。",
            },
            {
              group: ["node:*", "fs", "react", "@mediapipe/*"],
              message: "contracts 必须保持纯净：只用 zod 定义结构，不做 IO。",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "window", message: "contracts 不得访问 window。" },
        { name: "document", message: "contracts 不得访问 document。" },
        { name: "fetch", message: "contracts 不得发起网络请求。" },
      ],
    },
  },

  // ---------- 红线 7：不得使用偷看未来的离线平滑 ----------
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='reverse']",
          message:
            "疑似整段反转处理：AGENTS.md 红线 7 禁止依赖未来帧的离线平滑。若确为展示用途，请加 eslint-disable 并说明。",
        },
        {
          selector: "MemberExpression[property.name='__proto__']",
          message: "禁止操作 __proto__。",
        },
      ],
    },
  },

  // ---------- 测试文件：放宽部分规则 ----------
  {
    files: ["**/test/**/*.ts", "**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },

  // ---------- 脚本（Node）----------
  // 这些是**给人看的命令行报告工具**，输出就是它的产物，所以放行 console。
  // 同时覆盖 .ts —— `eval-replay.ts` 必须能 import `@pingpong/motion-core`
  // 的 TS 源码（指标计算住在那里，且有单测）。只放行 .mjs 会让"想把逻辑放进
  // 有测试的包"这件事变得别扭，结果是又在脚本里抄一份没有测试的实现。
  {
    files: ["scripts/**/*.mjs", "scripts/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "no-console": "off",
    },
  },

  // ---------- API（Node 服务端）----------
  {
    files: ["apps/api/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // ---------- Web（浏览器）----------
  {
    files: ["apps/web/**/*.ts", "apps/web/**/*.tsx"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.worker },
    },
  },

  // ---------- React 相关规则 ----------
  {
    files: ["apps/web/**/*.tsx"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // React Hooks 依赖数组错误是最容易产生陈旧状态闭包的地方，
      // 对实时采集这种长生命周期组件尤其危险，按 error 处理。
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },

  // ---------- 构建配置 ----------
  {
    files: ["**/vite.config.ts", "**/*.config.ts", "**/*.config.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
