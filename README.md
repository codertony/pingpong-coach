# pingpong-coach

实时乒乓球训练反馈 MVP。**摄像头 → 自动切分挥拍 → 二维动作测量与关键帧 → 一次多模态模型调用 → 一条有证据的反馈。**

当前状态：**P0 + P1 代码骨架已完成**。工程护栏齐备（类型 / 架构约束 / 格式 / 接线审计 /
文档一致性 / 密钥守卫 / 依赖体积预算 / CI），**648 项测试**（575 单元 + 73 浏览器）。
模型调用默认走 `mock`，**不配任何密钥也能跑通全链路**。

> ⚠️ **这是一份契约完整、可编译、可测试的工程骨架，不是已验证的产品。**
>
> 所有阈值都是**暂定值**，所有评分规则都是 `observation_only`（未审核）。
> **"识别准不准"目前一项目证据都没有**：
>
> - 骨架贴合只在**一支素材、一个人、一个机位**上目视确认过一次（判定者还是看图模型）；
> - 真实摄像头下**从未取到过流**（[F-009](./docs/known-failures.md)，OPEN）；
> - `evaluation/` 里没有真实素材，所以切分与指标的准确率**无法计算**；
> - 真实大模型只测过**一轮**（链路可用、图片确实被看懂），**建议质量与费用未评估**。
>
> 详见 [已知失败 F-001 ~ F-042](./docs/known-failures.md)、[评测日志](./docs/evaluation-log.md)、[路线图](./docs/roadmap.md)。

---

## 1. 环境要求

| 项目 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | **≥ 22.12.0** | 用到较新的 ESM / Worker 特性 |
| pnpm | **10.28.2** | 已写入 `package.json` 的 `packageManager` 字段 |
| 浏览器 | **Chrome / Edge 最新版** | 需要 `requestVideoFrameCallback`、Web Worker、WebAssembly SIMD |
| 摄像头 | 任意 USB / 内置摄像头 | 训练模式需要；导入视频模式可以完全不用摄像头 |

安装 pnpm（若还没装）：

```bash
npm install -g pnpm@10.28.2
```

> **网络**：仓库内 `.npmrc` 指向 `registry.npmmirror.com`（国内镜像）。
> 如果你的网络能直连 `registry.npmjs.org`，删掉 `.npmrc` 即可。
> 另外 `pnpm models:fetch` 需要访问 `storage.googleapis.com`（Google 的模型托管），
> 受限网络下会失败并**明确说明原因**，不会静默换版本。

---

## 2. 快速开始

```bash
# 1) 克隆（换成你实际用的地址）
git clone <仓库地址> pingpong-coach
cd pingpong-coach

# 2) 安装依赖
pnpm install

# 3) 下载姿态模型（约 20 MB；会校验 sha256，失败时不静默换版本）
pnpm models:fetch

# 4) 同时启动 API 和 Web
pnpm dev:all
```

启动后：

- Web 界面：<http://127.0.0.1:5173>
- API 健康检查：<http://127.0.0.1:8787/api/health>

Vite 已配置代理，前端 `/api/*` 会转发到 `127.0.0.1:8787`，**不需要手动处理跨域**。

只想跑其中一个：

```bash
pnpm dev:api    # 只起后端
pnpm dev        # 只起前端
```

> **模型与 WASM 运行时不入库**（`apps/web/public/models/`、`apps/web/public/wasm/` 都在 `.gitignore` 里）——
> 它们是二进制资产，由 `pnpm models:fetch` 与安装依赖后的复制步骤产生。所以**第 3 步不能跳过**。
>
> **摄像头权限**：浏览器只在 `localhost` / `127.0.0.1` 或 HTTPS 下才把页面视为安全上下文。
> 用局域网 IP（如 `192.168.x.x`）访问会被浏览器拦截。

---

## 3. 接真实大模型（可选）

**默认走 `mock`，无需任何配置即可跑通全链路。** 想接真实模型时：

```bash
cp .env.example .env
# 然后编辑 .env，填上密钥
```

```env
MODEL_API_KEY=你的密钥
MODEL_BASE_URL=https://api.deepseek.com
MODEL_ID=deepseek-flash
```

`.env` **已被 `.gitignore` 忽略，绝不要提交它**。也可以不用文件、直接给 API 进程设环境变量
（两者等价，**环境变量优先于 `.env`**）。

> ⚠️ **两个坑，都实测过**（见 [F-039](./docs/known-failures.md)）：
>
> 1. **变量名没有 `PPC_` 前缀**。早期文档写过 `PPC_MODEL_API_KEY` 之类，那些名字**代码里一个都不读** ——
>    照着做会**静默地跑成 mock**。
> 2. **三缺一不会报错，会退回 mock**。安全性靠**显著标注**保证：`/api/health` 会写
>    `modelMode: "mock"`，界面上也有 mock 徽标。**先看健康检查确认模式，别靠"没报错"推断。**

第三方模型的地址要用**它自己的 OpenAI 兼容端点**（本仓库只讲 `/chat/completions`），
不要填 Anthropic 端点。

| 变量 | 必需 | 默认 |
| --- | --- | --- |
| `MODEL_API_KEY` | ✅（live 必需） | — |
| `MODEL_BASE_URL` | ✅（live 必需） | — |
| `MODEL_ID` | ✅（live 必需） | — |
| `PORT` | | `8787` |
| `HOST` | | `127.0.0.1` |
| `MODEL_TIMEOUT_MS` | | `15000`（实测中位延迟约 3.9 s，见 F-038）|
| `MODEL_MAX_TOKENS` | | `2000`（**推理模型**先花推理 token，太小会把正文截断）|
| `MODEL_REASONING_EFFORT` | | **不设置**（透传；实测**不设反而更省**，见[评测日志](./docs/evaluation-log.md)）|
| `PPC_ENV_FILE` | | —（显式指定 `.env` 路径，指定后只读它）|
| `SESSION_MODEL_CALLS_PER_20_MIN` | | `60`（每会话 20 分钟内允许的模型调用次数；**费用保护**，只在 live 下生效）|
| `PPC_NO_ENV_FILE` | | —（设为 `1` 则**完全不读 `.env`**；e2e 会自己起 API，不隔离就会跑成 live **并真的花钱**，见 F-041）|

`.env` 的查找顺序：`PPC_ENV_FILE` 指定的路径 → `apps/api/` 下的 `.env` → **仓库根目录**的 `.env`。

**密钥不会被误提交**：`pnpm verify` 里有一道 `check:secrets` 守卫，扫**已被 git 跟踪的文件**里
有没有像密钥的串，并确认 `.env` 仍被忽略。命中时**只报文件名、行号与打码后的前几位，
绝不打印命中内容**（打印就等于把密钥再写进 CI 日志）。

**用量与费用**：每次模型调用，服务端会记一条日志（`modelId` / `inputTokens` / `outputTokens` /
`modelElapsedMs`，mock 调用标着 `mock` 不计费）。响应体里**不带**这些数字，所以要看花费请查
API 日志。实测一次分析约 **1200 入 / 600~800 出** tokens（含关键帧图片）。

确认当前模式：

```bash
curl http://127.0.0.1:8787/api/health
# → {"ok":true,"version":"0.1.0","modelMode":"mock","modelId":"mock-coach",
#    "ruleVersion":"...","knowledgeVersion":"...","nodeVersion":"v22...","uptimeSec":...}
```

`modelMode` 会如实反映当前模式，UI 上也会显式标注。**mock 的结果绝不能被当成真实延迟或精度证据。**

---

## 4. 常用命令

```bash
# 开发
pnpm install          # 安装依赖
pnpm dev:all          # 同时启动 API + Web
pnpm dev              # 只启动 Web
pnpm dev:api          # 只启动 API

# 质量门禁
pnpm verify           # 一把梭：见下
pnpm typecheck        # 全部包的类型检查（strict + noUncheckedIndexedAccess）
pnpm lint             # ESLint（含架构边界约束）
pnpm lint:fix         # ESLint 自动修复
pnpm format           # Prettier 格式化
pnpm format:check     # Prettier 检查
pnpm audit:wiring     # 接线审计：找出"别处都没提过"的孤儿导出（严格模式，退出码非 0 即失败）
pnpm check:docs       # 文档一致性：命令 / 路径 / 测试总数声明是否对得上仓库实际
pnpm check:secrets    # 密钥守卫：被跟踪文件里有没有像密钥的串
pnpm check:bundle     # 依赖体积预算（主包 gzip 上限 160 KiB）
pnpm test             # 全部单元测试
pnpm test:e2e         # 真实浏览器端到端测试
pnpm build            # 全量构建
pnpm clean            # 清理构建产物

# 模型与评估
pnpm models:fetch     # 下载并校验模型资产（按 models/manifest.json）
pnpm eval:replay      # 分段回放评估（temporal IoU / precision / recall）
pnpm annotate:tolerance  # 人工标注**要标多准**：把 IoU ≥ 0.5 换算成毫秒（= 该次挥拍时长的 25%）
                      # 缺人工标注时**明确拒绝输出任何准确率数字**
pnpm diagnose:thresholds   # 阈值诊断：给出准备区半径的可行区间（不是准确率，也不改阈值）
```

`pnpm verify` 的完整顺序：

```
typecheck → typecheck:scripts → lint → format:check → audit:wiring
          → check:docs → check:secrets → test → build → check:bundle
```

**`pnpm test:e2e` 刻意不在 `verify` 里** —— 它要装浏览器、起 5 个进程，不适合每次门禁都跑。

容器：

```bash
docker build -t pingpong-coach .          # 或 podman build
docker run -d -p 8787:8787 pingpong-coach # → http://127.0.0.1:8787
```

单容器同时提供 **API 与前端静态产物**（`apps/api` 本身托管 `apps/web/dist`，
见 `apps/api/src/server.ts` 的 static 注册 + SPA 回退），不需要 nginx 或第二个容器。

---

## 5. 目录结构

```
pingpong-coach/
├─ apps/
│  ├─ api/                  # Fastify 5 后端：知识检索 → 组 prompt → 调模型 → 校验输出
│  └─ web/                  # React 18 + Vite 6 前端：采集 → Worker 推理 → 分组 → 反馈
├─ packages/
│  ├─ contracts/            # Zod schema 单一事实来源（PoseFrame / StrokeEvent / FeatureSet / …）
│  └─ motion-core/          # 纯 TS 动作计算：几何、滤波、质量、切分、特征、规则
├─ knowledge/               # 知识条目（当前 status 均为 observation_only）
├─ configs/thresholds.json  # 全部阈值的规范快照（**不被运行时读取**，由一致性测试双向守着）
├─ models/manifest.json     # 模型清单 + SHA-256（已按实下载回填）
├─ evaluation/samples.json  # 三层标注样本清单（当前为空 ← 最大的缺口）
├─ scripts/                 # fetch-models / eval-replay / check-{bundle,docs,secrets} / audit-wiring
├─ docs/                    # spec / acceptance / data-contracts / decisions
│                           # + known-failures（F-001~F-042）/ evaluation-log / roadmap
│                           # + local-verification（本机验证清单）
├─ .github/workflows/       # CI：verify / e2e / docker 三个 job
├─ eslint.config.mjs        # 架构护栏：依赖方向 + 红线约束（违规即报错）
├─ .husky/                  # 提交前门禁（lint-staged）
├─ Dockerfile               # 单容器镜像（三阶段）
└─ .dockerignore
```

**依赖方向不可违反**：`contracts` 谁都能依赖；`motion-core` 不依赖 DOM / React / MediaPipe /
数据库 / 网络；`apps/*` 之间不互相导入。由 ESLint 的两层规则（`boundaries` 管相对路径、
`no-restricted-imports` 管裸包标识符）拦下，**四条违规路径逐一验证过会报错**。

---

## 6. 数据流

```
摄像头 / 导入视频
  → PoseFrame（33 关键点 + 质量标记）
  → StrokeEvent（切分状态机：ready → backswing → forward → returning）
  → FeatureSet（肩髋归一化后的几何量 + 一致性）
  → EvidencePacket（代表帧 + 数值 + 缺失原因）
  → 一次多模态模型调用
  → CoachFeedback（观察 / 依据 / 建议 / 置信度 / 被拒回的结论）
```

> **关键帧图片链路**：采集侧会把帧缩放到 960 长边、编成 JPEG 放进关键帧缓存，
> 成组时回溯挑选最多 6 张进证据包。（F-028 曾整条断掉 —— 缓存没有任何产品代码写入，
> 于是"多模态调用"实际收到纯文本；现已接通并有真实浏览器回归。）
> 会话取不到图时会**如实提示**，不静默。

契约定义全部在 `packages/contracts/`，是**唯一的事实来源**。

---

## 7. 测试与验证

```bash
pnpm verify         # 一把梭门禁（含全部单元测试）
pnpm test:e2e       # 真实浏览器端到端测试（Playwright + 真 Chrome）
```

**当前共 648 项测试**（575 单元 + 73 浏览器）：

| 包 | 单元测试 | 浏览器测试 |
| --- | --- | --- |
| `@pingpong/contracts` | 32 | — |
| `@pingpong/motion-core` | 218 | — |
| `@pingpong/api` | 179（178 通过 + 1 按需跳过） | — |
| `@pingpong/web` | 105 | 72 |
| **合计** | **534** | **72** |

> **默认一跑通过的不是全部。** `api` 有 1 项、浏览器有 12 项是**按需跳过**的探针
> （需要真实素材、真实摄像头或 20 分钟时长），所以 `pnpm test:e2e` 的默认输出是
> `60 passed, 12 skipped`。这不是失败，也**不是**"全绿"——它们的证据要你本机的素材和设备才能产生。
> 跑法见 [`docs/local-verification.md`](./docs/local-verification.md)。

### 这些测试证明的是什么

- 几何、滤波、切分状态机、特征提取、规则判定在**构造数据**与**边界数据**上正确；
- 输出校验能拦住未审核规则、缺失值填 0、非法结构；
- **架构约束是真的生效的** —— 依赖方向与红线都有测试或 lint 守着；
- 浏览器测试用**真实 Chromium** 跑，覆盖 jsdom 做不到的部分：真实 Canvas 像素、
  真实 Worker 跨线程、真实 `ImageBitmap` 句柄释放；
- 关键帧图片链路、`.env` 载入、模型用量记录等**容易静默失败**的接线有回归。

### 这些测试不能证明什么

- **骨架在你的机位上是否贴合关节** —— 只在一支素材上目视确认过一次（一个人、一个机位，
  判定者还是看图模型）。换成你的机位仍是独立证据（F-006，OPEN）；
- **真实摄像头下的姿态稳定性** —— 本机能枚举到摄像头、但**取不到流**（F-009）；
- **真实选手动作的切分准确率** —— 分段流水线已通、能出指标，但缺人工标注就没有
  precision / recall；且已知连续对拉会**合并相邻几板**（F-022）；
- **真实模型的延迟与建议质量** —— 链路与图片确实被看懂已验，但"接上图片之后建议是否更好"
  没验过，费用也只是算出来过、没有长期统计；
- **20 分钟连续运行的稳定性** —— 用合成帧实测过一次（队列无积压、吞吐不衰减），
  但**不是真人连续练习**；
- **手部 / 手指细节的可用性** —— 链路上三个静默缺陷已修（F-020 / F-021），
  但在这支素材上检出率只有 2/31 帧，其中一帧还是画在人脸上的**误检**。

上述几项都需要真实设备 + 真实素材，**必须在你自己的机器上实测**：

- 👉 逐条勾选的清单：[`docs/local-verification.md`](./docs/local-verification.md)
- 👉 功能待办与"哪些我做、哪些你做"的分工：[`docs/roadmap.md`](./docs/roadmap.md)

---

## 8. 排障

**`pnpm install` 报 `Unsupported engine`**
→ Node 版本低于 22.12.0，升级 Node。

**装依赖很慢或超时**
→ 见第 1 节的网络说明。`.npmrc` 指向的是国内镜像源。

**`pnpm models:fetch` 失败 / 校验不通过**
→ 脚本**不会静默回退**。先查网络（需可达 `storage.googleapis.com`）；
若哈希与 `models/manifest.json` 不符，说明上游模型更新了，需人工确认后再更新 manifest 里的
`sha256`。**不要绕过校验。**

**Web 起来后画面黑屏、无骨架**
→ 打开 DevTools Console，看 Worker 是否加载失败。若提示 GPU delegate 不可用，
代码会自动降级到 CPU 并在 UI 上**如实标注降级**（不会假装没问题）。

**页面提示「摄像头已找到，但一直没有画面（启动超时）」**
→ 说明浏览器**枚举到了设备**、但拉不起流。先跑探针把三种情况分开：

```bash
PPC_PROBE_CAMERA=1 pnpm --filter @pingpong/web test:e2e camera-enumeration
```

它会自己起一个**真实 Chrome**，逐个设备试开并打印结果 —— "没有设备" / "有设备但起不来" /
"只有某个虚拟摄像头不行"三种情况一眼分得开。若列表里有一堆**虚拟摄像头**（如 XR 头显注册的设备），
先在界面「视频源」里换设备；若真实摄像头也起不来，把 USB 摄像头**换个口重新插**再试（详见 F-009）。

**`/api/health` 正常但反馈报错**
→ 看 API 终端日志。一次会话只允许**一个在途模型请求**，且**不自动重试**（避免重复计费）。

**`pnpm test:e2e` 起不来，报 `EADDRINUSE`**
→ e2e 会起 5 个进程，端口可由环境变量覆盖。被占用时换端口即可，**不要**去关掉占用端口的软件：

```bash
E2E_STAGE2_PORT=8991 pnpm test:e2e
```

端口与对应变量：vite `E2E_PORT`(5199)、API `E2E_API_PORT`(8788)、live API `E2E_API_LIVE_PORT`(8789)、
假模型供应商 `E2E_FAKE_MODEL_PORT`(8790)、stage2 转发 `E2E_STAGE2_PORT`(8891)。

**改了 `.env` 之后 `test:e2e` 真的打到了付费模型**
→ e2e 会自己起 API 进程，会继承你的 `.env`。用 `PPC_NO_ENV_FILE=1` 隔离（见 F-041）。

---

## 9. 下一步该做什么

骨架已经能编译、能测试、能跑通 mock 全链路。**接下来不是继续加功能，而是去验证假设**：

1. `pnpm models:fetch` 拉模型，真机跑起来看骨架抖动程度；
2. 录 3~5 段真实正手攻球，按 `evaluation/samples.json` 的三层结构标注；
3. 跑分段评估，**三步缺一不可**（`evaluation/samples.json` 的 `$howToEvaluate` 里有完整说明）：

   ```bash
   # 3a. 导出观测：用产品真实的 TrainingSession 逐帧跑一遍素材
   PPC_VERIFY_VIDEO="<素材绝对路径>" pnpm --filter @pingpong/web test:e2e segmentation-eval
   # 3b. 照着导出的联系表（每 0.25 s 一格、时间戳烧在画面上）标真值
   # 3c. 算指标
   pnpm eval:replay --manifest evaluation/samples.json
   ```

   **没有人工标注时它会明确拒绝输出任何准确率数字** —— 没真值的指标是编造的。

4. 依据实测结果**修正**暂定阈值 —— 规则阈值在 `packages/motion-core/src/rules.ts` 的
   `DEFAULT_THRESHOLDS`、分段阈值在 `src/segmentation.ts` 的 `DEFAULT_SEGMENTATION`，
   并同步 `configs/thresholds.json`；
5. 阈值稳定后，才考虑把知识条目的 `observation_only` 升级为可给出"合格"判定。

**不要在没跑过真实数据之前调阈值。** 那样只是把猜测写进配置。

---

## 10. 工程纪律

见 [`AGENTS.md`](./AGENTS.md)（12 条硬红线）。最核心的几条：

- 缺失值用 `null` + `reasonIfMissing`，**禁止用 0 填充**（0 是合法的测量值）；
- 只做**因果（在线）**滤波，**禁止**偷看未来帧的离线平滑；
- 未审核的规则**只能**输出 `observation_only`，禁止说"合格"；
- 模型输出**必须在服务端校验**，不能只靠 prompt 约束；
- 模型调用**不自动重试**（避免重复计费与陈旧播报）；
- 命名要诚实：是 `return_after_wrist_peak_ms`，就**不要**叫 `recovery_after_impact_ms`。

文档纪律同样重要：**文档会过时，以代码和测试为准**。改完代码顺手跑一次 `pnpm check:docs` ——
它专抓"提到不存在的命令 / 不存在的路径 / 各文档声明了互相矛盾的测试总数"这一类机械漂移。
