# HANDOFF.md · Coding Agent 交接说明

> **这份文档是写给下一个接手这个仓库的 AI 编码助手的。**
> 目标是：读完这一份，就能知道**项目是什么、现在到哪了、什么不能碰、下一步该做什么**。
>
> 人类读者请优先看 [`docs/local-verification.md`](./local-verification.md)（本机验证清单）
> 和 [`docs/roadmap.md`](./roadmap.md)（功能分工）。

**文档版本**：2026-09-16 · 对应提交：`git log -1` 查看最新提交
**最近一次全量验证**：`pnpm verify` 退出码 0（386 项单元测试 + 依赖体积预算），`pnpm test:e2e` 47 passed

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
| 5 | [`docs/known-failures.md`](./known-failures.md) | 已踩过的坑与**待验证能力**（F-001 ~ F-013）**+ F-006/F-009/F-013 仍未解决** |
| 6 | [`docs/roadmap.md`](./roadmap.md) | 还剩什么、哪些需要人类介入 |
| 7 | [`docs/decisions.md`](./decisions.md) | 为什么这样选、何时替换 |
| 8 | [`docs/evaluation-log.md`](./evaluation-log.md) | 实测结果（严格区分事实/推测/未验证） |

**如果只读一份**：读 `AGENTS.md` 的红线章节。那 12 条是这个项目最容易犯、且后果最严重的错误。

---

## 3. 仓库结构（每块负责什么）

```
pingpong-coach/
├─ packages/contracts/      588 行 · zod schema 单一事实来源
│   PoseFrame / StrokeEvent / FeatureSet / EvidencePacket / CoachFeedback
│   ⚠️ 改字段先改这里，再改使用方
│
├─ packages/motion-core/   2081 行 · 纯计算，无 IO
│   coordinates  坐标与角度（含长宽比修正 F-004）
│   filter       因果滤波（禁止离线平滑 —— 红线 7）
│   geometry     几何量
│   quality      质量评估与降级理由
│   segmentation 挥拍切分状态机（F-001 修在这里）
│   features     特征提取
│   rules        规则判定（红线 4 卡在这里）
│   readiness    准备区标定（速度加权；见 F-012）
│   hand         手部 21 点几何（只测量，不推断拍面 —— 红线 3）
│   hand-assignment  手部左右分配（按姿态腕部锚点，不用 handedness 标签）
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
├─ apps/web/               4301 行 · React 18 + Vite 6
│   capture/   摄像头采集 + 帧调度（位图释放最容易漏）
│   vision/    pose.worker.ts（在 Worker 里跑 MediaPipe）+ pose-engine.ts（协议层）
│   training/  训练会话状态机 + 骨架叠加绘制
│   evidence/  关键帧选择 + 证据打包
│   review/    后端 API 客户端
│   audio/     语音播报（Web Speech API）
│   ui/        App.tsx (1176 行) + ReviewPanel.tsx (312 行)
│
├─ knowledge/          训练知识条目（当前 status 均为 observation_only）
├─ configs/thresholds.json   全部阈值（均为暂定值）
├─ models/manifest.json      模型清单（sha256 已按实下载回填：pose ×2 + hand ×1）
├─ evaluation/         真实素材与标注（**当前为空** ← 这是最大的缺口）
├─ scripts/            fetch-models / eval-replay / check-bundle
└─ docs/               见第 2 节
```

**源码 8120 行（42 个文件），测试 7648 行（41 个文件）。** 比例约 0.94:1，这不是巧合 —— 见第 6 节。

> 复算：`git ls-files 'packages/contracts/src/*' 'packages/motion-core/src/*' 'apps/api/src/**' 'apps/web/src/**' | xargs wc -l`
> 测试同理，把路径换成 `'packages/*/test/*' 'apps/*/test/*' 'apps/web/e2e/**'`。

---

## 4. 当前状态：已验证 vs. 未验证

这一节是交接的**核心**。请严格区分，不要把左侧当成右侧的证据。

### ✅ 已验证（有测试守着）

| 项 | 证据 |
| --- | --- |
| 数据契约正确性与内部一致性 | contracts 30 项测试 |
| 几何/滤波/切分/特征/规则/准备区标定/手部几何 | motion-core 169 项测试 |
| 后端全链路（含 mock） | api 130 项测试 |
| 前端采集/证据/播报/组件渲染/配色对比度 | web 57 项 vitest（含 jsdom + Testing Library 渲染测试） |
| **浏览器真实行为** | **web 47 项 Playwright（真实 Chromium）** |
| 架构依赖方向 | ESLint boundaries + no-restricted-imports，**四条违规路径逐一验证会报错** |
| 畸形输入不 500、不 throw | api fuzz 3 项 + contracts fuzz 3 项 |
| 依赖体积不超预算 | `pnpm check:bundle`：合计 gzip 135.7 KiB / 预算 160 KiB |
| 12 条红线中的可测部分 | 分散在上面各处，见第 5 节 |

浏览器测试覆盖的是 jsdom **做不到**的部分：真实 Canvas 像素、真实 Worker 跨线程、
真实 `ImageBitmap` 句柄释放、真实 `atob` 往返。

### ❌ 未验证（**这一栏才是重点**）

| 项 | 为什么未验证 |
| --- | --- |
| **骨架是否贴合关节** | 🔴 假摄像头驱动下画面无人，`detected` 恒为 `false`，叠加层一次都没画过 → **F-006 仍 OPEN** |
| GPU 委托**失败**时的降级是否平滑 | 本机 GPU 直接成功（初始化 174 ms）；降级路径只验证过"能连续实例化"，没经历过真实失败 |
| 真实摄像头下的姿态稳定性 | 本机浏览器枚举不到任何摄像头 → **F-009 OPEN**，从未在真实画面上跑过 |
| 真实挥拍的分段准确率 | `evaluation/` 为空 |
| 二维肘角在真实动作上的 MAE | 只验证过构造数据 |
| 端到端延迟 | 同上；只有单帧热路径的性能哨兵（每帧 < 10 ms 上限），不是延迟测量 |
| 真实多模态模型的质量/延迟/费用 | 一直跑 mock |
| 20 分钟连续运行稳定性 | 没跑过 |
| 跨平台行为 | 沙箱（Linux + Chromium）与本机（Windows 11 + Chrome）都跑过；其余平台没有 |
| 模型输出经**服务端校验**那一段 | 需要走到模型调用之后，而 mock 模式不经过模型调用；`validate.test.ts` 有 21 项单测直接覆盖，但没有端到端用例（见 roadmap A2 的说明） |

> 🔴 **最重要的一句话**：
> 测试从 172 涨到 433（386 单元 + 47 e2e），但**增量几乎全部落在"代码正确性"上**。
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
pnpm verify      # typecheck → lint → format:check → test → build → check:bundle
```

CI（`.github/workflows/ci.yml`）跑的是同一套 + `pnpm test:e2e`。
`verify` 现在含 `format:check` 与 `check:bundle`，与 CI 的 verify job 一致（T-1 已完成）。
唯一刻意的差别：`test:e2e` **不在** `verify` 里 —— 它要装浏览器，不适合每次门禁都跑。

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
本机（Windows 11）已确认如此：模型权重与 `/wasm` 运行时都已下载并校验，`models/manifest.json`
的 `sha256` 与字节数已回填。**不要**因为沙箱下不到模型就说"模型不存在"。

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

### ✅ T-1 · 让本地门禁与 CI 一致 —— 已完成（2026-09-16）

`verify` 现在是 `typecheck → lint → format:check → test → build → check:bundle`，
CI 的 verify job 跑同一套；`test:e2e` 仍独立（需要浏览器）。
新增 `scripts/check-bundle.mjs`：主包 gzip 预算 160 KiB，当前约 121 KiB。

### 🟡 T-2 · 组件级测试 —— 部分完成（2026-09-16）

已引入 `@testing-library/react` + `jsdom`，新增 8 项渲染测试：
`App.test.tsx`（mock 标记必须显著可见 / 健康检查失败时如实显示"后端未知"）、
`ReviewPanel.test.tsx`（空态、反馈渲染、模型失败态、缺失值渲染为"缺失"绝不填 0、回调）。

**仍未覆盖**：采集状态流转、摄像头错误态在界面上的实际呈现。

### T-3 · 前后端串联测试（中）—— 仍未做

前后端仍是**分段测的**：`api-client.e2e.ts` 在浏览器里测了客户端的成功与降级路径
（网络不可达、HTTP 500、非 JSON 响应），但后端是替身，没有真实的 API 进程参与。
`app.e2e.ts` 走的是整页链路，但止于"引擎就绪 + 画面接上"，没走到报告渲染。

**验收**：起一个真实的 API 进程，前端在浏览器里从 `POST /api/coach/analyze` 走到报告渲染。

### 🟡 T-4 · 错误路径补测（中）—— 部分完成

已覆盖：畸形请求体（api 与 contracts 各 3 项模糊测试，断言绝不 500 / 绝不 throw）、
后端不可达与 HTTP 500（`api-client.e2e.ts`）。
**仍未覆盖**：网络中途断开、摄像头中途被拔 —— 后者需要真实设备。

### 🟡 T-5 · 性能基线（中）—— 部分完成

已给 `motion-core` 每帧热路径的四个函数定出 **< 10 ms** 的哨兵上限（`perf.test.ts`），
并给主包 gzip 体积定了 160 KiB 预算。
**仍未覆盖**：`FrameScheduler` 在 60fps 下的丢帧率。
注意这些是**宽松哨兵**，用来拦"数量级退化"，不是性能指标本身 ——
真实设备上的延迟仍属未验证项（见第 4 节）。

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
3. 做 T-3（前后端串联）—— 当前最大的测试缺口         （中等）
4. 补齐 T-2 / T-4 / T-5 各自标注的剩余部分
5. 请人类完成 T-6 —— 骨架是否贴合关节               ← 关键分水岭
6. 请人类完成 T-7 —— 真实素材评估
7. 根据 T-6/T-7 的结果，决定是修 bug 还是加功能
```

**为什么这样排**：T-1 到 T-5 都是"在已知领域内加固"。
T-6 是分水岭 —— 在它完成之前，**任何关于识别质量的讨论都是空谈**，
所以不要在这之前花力气调 prompt 或优化阈值。

---

## 10. 反模式清单（别做这些）

| 别做 | 为什么 |
| --- | --- |
| ❌ 因为沙箱下不到模型，就删掉 F-006 或改成"已解决" | 那是掩盖问题，不是解决问题 |
| ❌ 声称"测试全绿所以识别准确" | 433 项测试（386 单元 + 47 e2e）里没有一项验证识别准确率 |
| ❌ 把合成数据的测试结果当真实动作的质量证据 | `AGENTS.md` 明确禁止 |
| ❌ 给模型调用加自动重试 | 违反红线 12，有测试守着 |
| ❌ 在未审核规则上输出"达标"结论 | 违反红线 4，这是安全约束不是功能 |
| ❌ 用 0 填补缺失值 | 违反红线 1，0 是合法测量值 |
| ❌ 悄悄降低验收阈值让测试变绿 | `AGENTS.md` 明令禁止；改阈值必须记录理由与版本 |
| ❌ 无差别调 prompt | 同一问题先限定两轮有证据的修复 |
| ❌ 为了测试通过而改测试预期 | 先问"是不是测试假设错了"，本项目已有 5 次是代码真错 |

---

## 11. 速查命令

下面这些**都在 `package.json` 的 `scripts` 里**，逐条核对过。仓库里**没有**
环境自检脚本，也没有 `scripts/setup.sh` / `setup.ps1` —— 早期文档写过它们，
但那些文件从未落进仓库，别照着敲。

| 命令 | 作用 |
| --- | --- |
| `pnpm verify` | 全量门禁（type → lint → format → test → build → bundle） |
| `pnpm test` | 只跑单元测试（386 项） |
| `pnpm test:e2e` | 只跑浏览器测试（47 项，真实 Chromium；会自起 vite + 一个真实 API 进程） |
| `pnpm check:bundle` | 依赖体积预算（gzip 160 KiB，当前约 121 KiB） |
| `pnpm lint` / `pnpm lint:fix` | ESLint（含架构边界） |
| `pnpm format` / `pnpm format:check` | Prettier |
| `pnpm dev` / `pnpm dev:api` / `pnpm dev:all` | 只前端 / 只后端 / 两个一起 |
| `pnpm models:fetch` | 下载并校验模型（`-- --write-hash` 回填 sha256） |
| `pnpm eval:replay` | 回放评测（无真实标注时会明确拒绝输出精度数字） |
| `pnpm clean` | 清理构建产物 |

环境自检没有脚本，手工等效操作是：
`node -v`（需 ≥ 22.12.0）、`pnpm -v`（需 10.28.2）、`pnpm store path`（确认存储盘）、
`curl http://127.0.0.1:8787/api/health`（服务起来后探活）。

---

## 12. 交接时的诚实声明

如果让人类评价这个项目的现状，请如实转达：

> 代码骨架完整，工程护栏齐备，**386 项单元测试 + 47 项浏览器测试全部通过**。
> 但**没有一项目前验证了"识别准不准"** —— 真实姿态推理只在本机验证到"链路能跑通、
> 委托是 GPU"，骨架是否贴合关节从未看过（假摄像头下画面无人，F-006 仍 OPEN），
> `evaluation/` 里也没有真实素材。
>
> 下一步的关键动作不是写更多代码，而是**由人在真实设备上完成 T-6 和 T-7**。
> 在那之前，所有性能与准确率数字都只是拟定目标。
