# HANDOFF.md · Coding Agent 交接说明

> **这份文档是写给下一个接手这个仓库的 AI 编码助手的。**
> 目标是：读完这一份，就能知道**项目是什么、现在到哪了、什么不能碰、下一步该做什么**。
>
> 人类读者请优先看 [`docs/local-verification.md`](./local-verification.md)（本机验证清单）
> 和 [`docs/roadmap.md`](./roadmap.md)（功能分工）。

**文档版本**：2026-09-15 · 对应提交：`git log -1` 查看最新提交
**最近一次全量验证**：`pnpm verify` 退出码 0（332 项单元测试），`pnpm test:e2e` 36 passed

> 📌 **文档会过时。** 如果本文描述与代码不符，**以代码和测试为准**，
> 并顺手把本文改对 —— 这是接手者的第一份贡献。
> 校验命令：`pnpm verify && pnpm test:e2e`。

---

## 1. 一句话说清项目

**实时乒乓球训练反馈 MVP**：摄像头 → 自动切分挥拍 → 二维动作测量 + 关键帧 → 一次多模态模型调用 → 一条有证据的反馈。

关键定位：**这是一份契约完整、可编译、可测试的工程骨架，不是已验证的产品。**
所有阈值是暂定值，所有评分规则都是 `observation_only`（未审核）。

---

## 2. 第一件事：先读什么

按这个顺序读，不要跳。

| 顺序 | 文件 | 为什么先读它 |
| --- | --- | --- |
| 1 | **本文档** | 全局态势、当前状态、下一步 |
| 2 | [`AGENTS.md`](../AGENTS.md) | **12 条硬性红线** + 依赖方向。改代码前必读 |
| 3 | [`docs/spec.md`](./spec.md) | 要做什么、当前阶段、已知限制 |
| 4 | [`docs/data-contracts.md`](./data-contracts.md) | 坐标、单位、时钟、缺失值约定 |
| 5 | [`docs/known-failures.md`](./known-failures.md) | 已踩过的坑（F-001 ~ F-006）**+ F-006 仍未解决** |
| 6 | [`docs/roadmap.md`](./roadmap.md) | 还剩什么、哪些需要人类介入 |
| 7 | [`docs/decisions.md`](./decisions.md) | 为什么这样选、何时替换 |
| 8 | [`docs/evaluation-log.md`](./evaluation-log.md) | 实测结果（严格区分事实/推测/未验证） |

**如果只读一份**：读 `AGENTS.md` 的红线章节。那 12 条是这个项目最容易犯、且后果最严重的错误。

---

## 3. 仓库结构（每块负责什么）

```
pingpong-coach/
├─ packages/contracts/      507 行 · zod schema 单一事实来源
│   PoseFrame / StrokeEvent / FeatureSet / EvidencePacket / CoachFeedback
│   ⚠️ 改字段先改这里，再改使用方
│
├─ packages/motion-core/   1694 行 · 纯计算，无 IO
│   coordinates  坐标与角度（含长宽比修正 F-004）
│   filter       因果滤波（禁止离线平滑 —— 红线 7）
│   geometry     几何量
│   quality      质量评估与降级理由
│   segmentation 挥拍切分状态机（F-001 修在这里）
│   features     特征提取
│   rules        规则判定（红线 4 卡在这里）
│   ⚠️ 不得引入 DOM / React / MediaPipe / 数据库 / 网络
│
├─ apps/api/               1150 行 · Fastify 5 后端
│   server      路由
│   config      模型模式判定（三要素齐全才走 live）
│   coach/
│     knowledge  知识检索（红线 4：未审核只能 observation_only）
│     prompt     提示词组装（红线 1：缺失值绝不渲染成 0）
│     provider   模型调用（红线 12：不自动重试）
│     validate   输出校验（红线 8：伪造证据一律拒绝）
│     dedupe     去重与并发锁
│     analyze    主编排
│
├─ apps/web/               3124 行 · React 18 + Vite 6
│   capture/   摄像头采集 + 帧调度（位图释放最容易漏）
│   vision/    pose.worker.ts（在 Worker 里跑 MediaPipe）+ pose-engine.ts（协议层）
│   training/  训练会话状态机 + 骨架叠加绘制
│   evidence/  关键帧选择 + 证据打包
│   review/    后端 API 客户端
│   audio/     语音播报（Web Speech API）
│   ui/        App.tsx (919 行) + ReviewPanel.tsx
│
├─ knowledge/          训练知识条目（当前 status 均为 observation_only）
├─ configs/thresholds.json   全部阈值（均为暂定值）
├─ models/manifest.json      模型清单（sha256 待首次下载后回填）
├─ evaluation/         真实素材与标注（**当前为空** ← 这是最大的缺口）
├─ scripts/            doctor / setup / fetch-models / eval-replay
└─ docs/               见第 2 节
```

**源码 6475 行，测试 5733 行。** 测试与源码接近 1:1，这不是巧合 —— 见第 6 节。

---

## 4. 当前状态：已验证 vs. 未验证

这一节是交接的**核心**。请严格区分，不要把左侧当成右侧的证据。

### ✅ 已验证（有测试守着）

| 项 | 证据 |
| --- | --- |
| 数据契约正确性与内部一致性 | contracts 27 项测试 |
| 几何/滤波/切分/特征/规则 | motion-core 141 项测试 |
| 后端全链路（含 mock） | api 127 项测试 |
| 前端采集/证据/播报逻辑 | web 37 项 vitest |
| **浏览器真实行为** | **web 36 项 Playwright（真实 Chromium 144）** |
| 架构依赖方向 | ESLint boundaries + no-restricted-imports，**四条违规路径逐一验证会报错** |
| 12 条红线中的可测部分 | 分散在上面各处，见第 5 节 |

浏览器测试覆盖的是 jsdom **做不到**的部分：真实 Canvas 像素、真实 Worker 跨线程、
真实 `ImageBitmap` 句柄释放、真实 `atob` 往返。

### ❌ 未验证（**这一栏才是重点**）

| 项 | 为什么未验证 |
| --- | --- |
| **真实姿态推理** | 🔴 沙箱内 `storage.googleapis.com` 被墙，模型下不来 → **F-006** |
| GPU 委托在真实硬件上能否成功 | 沙箱是软件环境；协议层已测，硬件层没有 |
| 真实摄像头下的姿态稳定性 | 沙箱无摄像头 |
| 真实挥拍的分段准确率 | `evaluation/` 为空 |
| 二维肘角在真实动作上的 MAE | 只验证过构造数据 |
| 端到端延迟 | 同上 |
| 真实多模态模型的质量/延迟/费用 | 一直跑 mock |
| 20 分钟连续运行稳定性 | 没跑过 |
| Windows / Chrome 实际行为 | 沙箱是 Linux + Chromium 144 |

> 🔴 **最重要的一句话**：
> 测试从 172 涨到 368，但**增量几乎全部落在"代码正确性"上**。
> 关于"这个产品准不准"的证据，**一项目前都没有**。
> 任何声称"识别准确率 X%"的说法，在当前状态下都是无根据的。

---

## 5. 红线执行现状（改代码前必须知道）

`AGENTS.md` 定义了 12 条红线。它们**不是文档摆设**，大部分已经变成会失败的测试。
如果你想改相关代码，先看这张表：

| 红线 | 固定它的测试/代码 | 改坏了的后果 |
| --- | --- | --- |
| 1 缺失不用 0 填充 | `api/test/prompt.test.ts` 断言缺失值绝不渲染成 `0` | 用户看到凭空的 0 值判定 |
| 2 腕峰 ≠ 击球时刻 | `contracts` + `motion-core` 类型层；`impactTimeMs` 恒 `null` | 编造不存在的击球时刻 |
| 3 禁止二维骨架推断发力等 | `api/src/coach/validate.ts` 的 `scanForbiddenClaims` | 输出伪科学结论 |
| 4 未审核规则只观察 | `api/test/knowledge.test.ts`：必须 `status === "reviewed"` **且** `referenceId != null` | 系统给出没资格的判定 |
| 5 镜像不改左右标签 | `web/e2e/canvas.e2e.ts` 用像素质心断言镜像对称 | 左右混淆 |
| 6 角度必须先乘回宽高 | `motion-core/test/geometry.test.ts` 6 个用例 | 60° 被算成 72°（F-004） |
| 7 禁用离线平滑 | ESLint `no-restricted-syntax` 拦 `.reverse()` | 用了未来数据 |
| 8 输出必须校验 | `api/test/validate.test.ts` + `analyze.test.ts` | 伪造证据被播报 |
| 9 模型不阻塞本地链路 | `analyze.test.ts`：模型失败仍返回 `httpStatus: 200` | 一个接口挂了整条链路停摆 |
| 10 mock 必须可见 | `server.test.ts` 断言 `/api/health` 标明 mock | mock 结果被当成真实数据 |
| 11 密钥只在服务端 | `prompt.test.ts` 断言 prompt 内无 API key | 密钥泄漏 |
| 12 不自动重试 | `provider.test.ts` 断言超时时 `fetch` **恰好调用 1 次** | 重复费用 + 陈旧播报 |

**特别注意第 12 条**：这是唯一用"调用次数"而非"结果"来断言的测试。
如果你想加重试逻辑，那个测试会红 —— 那是**故意**的。

---

## 6. 工程纪律（这个仓库的运行规则）

### 提交前门禁

```bash
pnpm verify      # typecheck → lint → format:check → test → build
```

CI（`.github/workflows/ci.yml`）跑的是同一套 + `pnpm test:e2e`。
**注意**：`pnpm verify` 目前**不含** `format:check` 和 `test:e2e`，
而 CI 含 `format:check`。这意味着你可能本地过、CI 挂。
→ 修复建议见第 8 节 T-1。

### 架构约束是真的会报错的

`eslint.config.mjs` 里做了两层：

1. `eslint-plugin-boundaries` —— 管**相对路径**的跨模块依赖；
2. `no-restricted-imports` —— 管**裸包标识符**（`@pingpong/motion-core`）。

**为什么需要两层**：`boundaries` 匹配的是文件路径，而跨包导入用的是裸标识符，
解析到 `node_modules` 里的软链。只用 boundaries 拦不住。这是实测发现并修掉的。

如果你要加一个跨包依赖，先确认它是否符合 `AGENTS.md` 的依赖方向表。

### 测试纪律

- 测试预期**不能**从被测算法的输出生成（否则是自证）。
- 不为静态文案和简单样式堆测试。
- **真实动作识别质量必须用真人标注数据验证** —— 合成数据只能验证计算与边界。
- 发现 bug 先想"这是不是我的测试假设错了"，再改代码。本项目已有 5 次是代码真错。

### 提交纪律

小批次提交，顺序：契约/采集 → 推理与叠加 → 分段/特征 → 证据/API → 反馈/复查 → 实测修复。
每次提交说明三件事：**能运行什么、证据是什么、尚未验证什么**。

---

## 7. 环境与已知陷阱

### 网络受限（环境影响，不是代码问题）

当前开发沙箱的实测可达性：

| 域名 | 状态 |
| --- | --- |
| `registry.npmmirror.com` | ✅ 可用（`.npmrc` 指向它） |
| `cdn.jsdelivr.net` / `unpkg.com` | ✅ 可用 |
| `storage.googleapis.com` | ❌ **不可达** ← 直接导致 F-006 |
| `github.com` / `huggingface.co` / `registry.npmjs.org` | ❌ 不可达 |

**如果你换了环境**（比如本地 Windows），这些限制可能不存在，`pnpm models:fetch` 就能成功。
**不要**因为沙箱下不到模型就说"模型不存在"。

### 其他陷阱

- **Vite 必须绑 `127.0.0.1`**：容器里默认绑 `localhost` 会失败。
  `playwright.config.ts` 里的 `webServer` 已处理。
- **Playwright 用系统 Chromium**：`resolveChromiumPath()` 会依次找
  `CHROMIUM_PATH` 环境变量 → 系统 Chrome/Edge → 回退 Playwright 自带。
- **空 `OffscreenCanvas` 建 `ImageBitmap` 会失败**：必须先画内容再 `createImageBitmap`。
  夹具里的 `makeRealBitmap` 就是干这个的。
- **Prettier 3 的 ignore 是 gitignore 语义**：`test-results/` 有效，`*/test-results/` **无效**。
- **`page.evaluate` 里的动态 import 相对页面 URL 解析**，不是相对测试文件。
  所以夹具把模块挂到了 `window.__fixture` 上。

---

## 8. 下一步该做什么

### T-1 · 让本地门禁与 CI 一致（小，建议先做）

**问题**：`package.json` 的 `verify` 脚本是
`pnpm typecheck && pnpm lint && pnpm test && pnpm build`，
缺 `format:check`，而 CI 有。本地绿、CI 红是真实存在的落差。

**改法**：把 `format:check` 加进 `verify`，并考虑把 `test:e2e` 拆成独立脚本
（因为它需要浏览器，不适合每次门禁都跑）。

**验收**：故意写一个格式错的文件，`pnpm verify` 必须在 `format:check` 阶段失败。

### T-2 · 组件级测试（中）

`App.tsx` 919 行、`ReviewPanel.tsx` 312 行，目前只有逻辑层测试，**没有组件渲染测试**。
需要引入 `@testing-library/react` + `jsdom` 环境。

**重点测**：采集状态流转、错误态展示、mock 标记是否可见。

### T-3 · 前后端串联测试（中）

现在前端和后端是**分段测的**，没有一条从 `POST /api/coach/analyze` 走到报告渲染的测试。

**验收**：起一个真实的 API 进程，前端在浏览器里走完整链路。

### T-4 · 错误路径补测（中）

网络中途断开、后端返回 502、摄像头中途被拔 —— 这些降级表现目前没测。

### T-5 · 性能基线（中）

给 `FrameScheduler` 在 60fps 下的丢帧率、`motion-core` 各特征函数耗时定出上限，
写成回归阈值。超过就失败。

### 🔴 T-6 · 真实姿态验证（**只有人类能做**）

**这是整条链路上最大的未知，也是你唯一无法自己解决的事。**

- 沙箱内 `storage.googleapis.com` 不可达，模型下不来；
- 所以**从来没有跑过一次真实的姿态推理**；
- 现有的 9 个 `pose-engine` 测试用的是**受控假 Worker**，只证明协议正确，
  **证明不了模型输出正确**。

**人类需要做的**（详见 `docs/local-verification.md` 阶段 3-4）：

```bash
pnpm models:fetch            # 能联网的环境下会成功
# 或手动下载 + 复制 WASM，见 local-verification.md
pnpm dev:all
# 然后站到镜头前，看骨架是否贴合关节
```

**完成后必须做的**：
1. 把结果记入 `docs/known-failures.md` 的 F-006，状态改为 CLOSED；
2. 如果骨架不贴合，按已知失败的分类口径归类并新建 F-007；
3. 更新 `docs/evaluation-log.md` 的未验证项表格。

### T-7 · 真实素材评估（**只有人类能做**）

`evaluation/` 目前为空。**没有真实素材，就无法回答"这产品准不准"。**
这是比 T-6 更根本的缺口 —— T-6 只验证"骨架贴不贴"，T-7 才验证"切分和指标准不准"。

---

## 9. 接手后的推荐路径

```
1. 读 AGENTS.md 的红线 + 本文档第 4、5 节          （30 分钟）
2. 跑 pnpm verify 和 pnpm test:e2e，确认基线        （5 分钟）
3. 做 T-1（门禁一致性）—— 小而明确，快速建立信心     （30 分钟）
4. 做 T-2 / T-3 / T-4 —— 补测试覆盖                 （视情况）
5. 请人类完成 T-6 —— 解锁真实姿态链路               ← 关键分水岭
6. 请人类完成 T-7 —— 真实素材评估
7. 根据 T-6/T-7 的结果，决定是修 bug 还是加功能
```

**为什么这样排**：T-1 到 T-4 都是"在已知领域内加固"。
T-6 是分水岭 —— 在它完成之前，**任何关于识别质量的讨论都是空谈**，
所以不要在这之前花力气调 prompt 或优化阈值。

---

## 10. 反模式清单（别做这些）

| 别做 | 为什么 |
| --- | --- |
| ❌ 因为沙箱下不到模型，就删掉 F-006 或改成"已解决" | 那是掩盖问题，不是解决问题 |
| ❌ 声称"测试全绿所以识别准确" | 368 项测试里没有一项验证识别准确率 |
| ❌ 把合成数据的测试结果当真实动作的质量证据 | `AGENTS.md` 明确禁止 |
| ❌ 给模型调用加自动重试 | 违反红线 12，有测试守着 |
| ❌ 在未审核规则上输出"达标"结论 | 违反红线 4，这是安全约束不是功能 |
| ❌ 用 0 填补缺失值 | 违反红线 1，0 是合法测量值 |
| ❌ 悄悄降低验收阈值让测试变绿 | `AGENTS.md` 明令禁止；改阈值必须记录理由与版本 |
| ❌ 无差别调 prompt | 同一问题先限定两轮有证据的修复 |
| ❌ 为了测试通过而改测试预期 | 先问"是不是测试假设错了"，本项目已有 5 次是代码真错 |

---

## 11. 速查命令

| 命令 | 作用 |
| --- | --- |
| `pnpm preflight` | 环境自检（退出码 0=通过 / 1=阻塞 / 2=警告） |
| `pnpm verify` | 全量门禁 |
| `pnpm test` | 只跑单元测试（332 项） |
| `pnpm test:e2e` | 只跑浏览器测试（36 项，真实 Chromium） |
| `pnpm lint` / `pnpm lint:fix` | ESLint（含架构边界） |
| `pnpm format` / `pnpm format:check` | Prettier |
| `pnpm dev:all` | 同时启动 API + Web |
| `pnpm models:fetch` | 下载并校验模型（受限网络会失败并说明原因） |
| `bash scripts/setup.sh` | 一键环境准备（macOS / Linux / WSL） |
| `.\scripts\setup.ps1` | 一键环境准备（Windows） |

---

## 12. 交接时的诚实声明

如果让人类评价这个项目的现状，请如实转达：

> 代码骨架完整，工程护栏齐备，**368 项测试全部通过**。
> 但**没有一项目前验证了"识别准不准"** —— 因为沙箱里从没跑过一次真实姿态推理，
> `evaluation/` 里也没有真实素材。
>
> 下一步的关键动作不是写更多代码，而是**由人在真实设备上完成 T-6 和 T-7**。
> 在那之前，所有性能与准确率数字都只是拟定目标。
