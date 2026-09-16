# pingpong-coach

实时乒乓球训练反馈 MVP。**摄像头 → 自动分组挥拍 → 二维动作测量与关键帧 → 一次多模态模型调用 → 一条有证据的反馈。**

当前状态：**P0 + P1 代码骨架已完成**，工程护栏（lint/格式/CI/提交门禁）已补齐，
**482 项单元测试 + 69 项浏览器测试全部通过**。
模型调用默认为 `mock` 模式（没有真实 API Key 也能跑完整链路）。

> ⚠️ 这是一份**契约完整、可编译、可测试**的骨架，不是已验证产品。
> 所有阈值都是**暂定值**，所有评分规则都是 `observation_only`（未审核），
> 真实精度和真实延迟**尚未验证** —— 姿态链路只在本机验证到"能跑通、委托是 GPU"，
> **骨架贴合已在一支真实素材上目视确认过一次**，但只有一个人、一个机位，
> 换成你的机位仍是独立证据，见 F-006（仍 OPEN）。
>
> 详见 `docs/known-failures.md`、`docs/evaluation-log.md`、`docs/roadmap.md`。

---

## 0. 安装位置

本仓库放在 **E 盘**：

```
E:\workSpace\pingpong-coach\
```

### 关于"别占满 C 盘"

网上常见的建议是"先把 pnpm/npm 的全局缓存挪出 C 盘"。**本机已经不需要这么做**，
实测状态如下（跑 `pnpm store path` 与磁盘属性即可复核）：

| 项 | 实测值 |
| --- | --- |
| 仓库位置 | `E:\workSpace\pingpong-coach` |
| pnpm store | `E:\.pnpm-store\v10`（**已在 E 盘**） |
| `node_modules` 占用 | 约 **245 MB**，且天然落在仓库目录里（不在 C 盘） |
| C 盘可用空间 | 约 **41 GB** |

`node_modules` 只有 245 MB 量级 —— 本项目虽然带了 MediaPipe + Vite + React + Vitest，
但 pnpm 用的是**内容寻址存储 + 硬链接**，同一个包在磁盘上只存一份。

**只有一种情况需要动手**：`pnpm store path` 显示 store 在 `C:\` 下，且 C 盘确实紧张。
那时候再执行：

```powershell
# 把 <你选定的盘> 换成实际想放的盘，例如 E:\
pnpm config set store-dir <你选定的盘>:\pnpm-store
```

验证：

```powershell
pnpm store path    # 应输出刚设置的路径
```

> 注意：这是一个**与仓库无关的全局设置**，会影响你机器上所有 pnpm 项目，
> 不要照抄某一份文档里的盘符 —— 先看自己的 `pnpm store path` 再决定。
> 另外 `npm config set cache` 对本项目没有意义：这里用 pnpm 装依赖，不经过 npm 的缓存。

---

## 1. 环境要求

| 项目 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | **≥ 22.12.0** | 仓库内用到较新的 ESM / Worker 特性 |
| pnpm | **10.28.2** | 已写入 `packageManager` 字段 |
| 浏览器 | **Chrome / Edge 最新版** | 需要 `requestVideoFrameCallback`、Web Worker、WebAssembly SIMD |
| 摄像头 | 任意 USB / 内置摄像头 | 训练模式需要；复盘模式可只看历史数据 |

安装 pnpm（若还没装）：

```powershell
npm install -g pnpm@10.28.2
```

---

## 2. 首次启动（Windows PowerShell）

```powershell
# 1) 进入仓库
cd E:\workSpace\pingpong-coach

# 2) 安装依赖
pnpm install

# 3) 下载姿态模型（约 10~30 MB；会校验 sha256，失败时不静默换版本）
pnpm models:fetch

# 4) 同时起 API 和 Web
pnpm dev:all
```

第 0 节提到的缓存盘设置**本机已经配置好**，首次启动不需要再做。
只有在 `pnpm store path` 指向 C 盘且 C 盘紧张时才需要处理（见第 0 节）。

启动后：

- Web 界面：<http://127.0.0.1:5173>
- API 健康检查：<http://127.0.0.1:8787/api/health>

Vite 已配置代理，前端 `/api/*` 会转发到 `127.0.0.1:8787`，**不需要手动处理跨域**。

只想跑其中一个：

```powershell
pnpm dev:api    # 只起后端
pnpm dev        # 只起前端
```

> 浏览器会要求摄像头权限。如果 `127.0.0.1` 上无法访问摄像头，
> 请确认用的是 `127.0.0.1` 或 `localhost`（这两个被浏览器视为安全上下文），
> 用局域网 IP（如 `192.168.x.x`）访问摄像头会被拦截。

---

## 3. 模型接口配置

默认走 **mock**，无需任何配置即可跑通全链路。
要接真实模型，在仓库根目录建 `.env`（该文件已被 `.gitignore` 忽略）：

```env
# 三者必须同时提供，缺一个就会启动失败（这是故意的，避免“配了一半”的静默降级）
PPC_MODEL_API_KEY=sk-xxxxxxxx
PPC_MODEL_BASE_URL=https://your-openai-compatible-endpoint/v1
PPC_MODEL_ID=your-multimodal-model-id

# 可选
PPC_PORT=8787
PPC_MODEL_MODE=live        # mock | live
PPC_REQUEST_TIMEOUT_MS=20000
```

**设计约束**：`live` 模式要求 `API_KEY` / `BASE_URL` / `MODEL_ID` **三者齐全**，
否则直接启动报错。不允许出现“以为在跑真模型、其实在跑 mock”的情况。

切换后可用健康检查确认当前模式：

```powershell
curl http://127.0.0.1:8787/api/health
# → {"status":"ok","modelMode":"mock", ...}
```

`modelMode` 会如实反映当前模式。UI 上也会显式标注，**mock 的结果绝不能被当成真实延迟/精度证据**。

---

## 4. 常用命令

```powershell
pnpm install        # 安装依赖
pnpm dev:all        # 同时启动 API + Web
pnpm dev            # 只启动 Web
pnpm dev:api        # 只启动 API
pnpm build          # 全量构建
pnpm typecheck      # 全量类型检查（strict + noUncheckedIndexedAccess）
pnpm test           # 全量单元测试
pnpm test:e2e       # 真实浏览器端到端测试
pnpm verify         # 一把梭门禁（类型 + lint + 格式 + 接线审计 + 文档一致性 + 测试 + 构建 + 体积预算）
pnpm lint           # ESLint（含架构边界约束）
pnpm lint:fix       # ESLint 自动修复
pnpm format         # Prettier 格式化
pnpm models:fetch   # 下载姿态模型到 apps/web/public/models/
pnpm eval:replay    # 分段回放评估（temporal IoU / precision / recall）。缺人工标注时**明确拒绝输出任何准确率数字**
pnpm audit:wiring   # 接线审计：找出"别处都没提过"的孤儿导出。**这条就是严格模式**（退出码非 0 即失败）；只出报告请跑 node scripts/audit-wiring.mjs
pnpm check:docs     # 文档一致性：命令 / 路径 / 测试总数声明是否对得上仓库实际
pnpm clean          # 清理构建产物

# 摄像头探针（需要真实摄像头；默认 skip，所以 CI 不受影响）
PPC_PROBE_CAMERA=1 pnpm --filter @pingpong/web test:e2e camera-enumeration

# 容器（Dockerfile 在本仓库根目录，已实测构建并跑通）
podman build -t pingpong-coach .
podman run -d -p 8787:8787 pingpong-coach   # → http://127.0.0.1:8787
```

---

## 5. 目录结构

```
pingpong-coach/
├─ apps/
│  ├─ api/                  # Fastify 5 后端：知识检索 → 组 prompt → 调模型 → 校验输出
│  └─ web/                  # React 18 + Vite 6 前端：采集 → Worker 推理 → 分组 → 反馈
├─ packages/
│  ├─ contracts/            # Zod schema 单一事实来源（PoseFrame/StrokeEvent/FeatureSet/…）
│  └─ motion-core/          # 纯 TS 动作计算：几何、滤波、质量、切分、特征、规则
├─ knowledge/               # 知识条目（当前 status 均为 observation_only）
├─ configs/thresholds.json  # 全部阈值（当前均为暂定值）
├─ models/manifest.json     # 模型清单 + SHA-256（已按实下载回填）
├─ evaluation/samples.json  # 三层标注样本（当前为空）
├─ scripts/                 # fetch-models、eval-replay、check-bundle
├─ docs/                    # spec / acceptance / data-contracts / decisions / 评测日志 / 已知失败
│                           # + roadmap（功能待办与分工）/ local-verification（本机验证清单）
├─ .github/workflows/       # CI：verify + e2e + docker 三个 job
├─ eslint.config.mjs        # 架构护栏：依赖方向 + 红线约束（违规即报错）
├─ .husky/                  # 提交前门禁（lint-staged）
├─ Dockerfile               # 单容器镜像（三阶段；已实测构建并跑通）
└─ .dockerignore
```

---

## 6. 数据流

```
摄像头
  → PoseFrame（33 关键点 + 质量标记）
  → StrokeEvent（切分状态机：ready → backswing → forward → returning）
  → FeatureSet（肩髋归一化后的几何量 + 一致性）
  → EvidencePacket（代表帧 + 数值 + 缺失原因）
  → 一次多模态模型调用
  → CoachFeedback（观察 / 依据 / 建议 / 置信度 / 被拒回的结论）
```

> **关键帧图片链路**：采集侧会把帧缩放到 960 长边、编成 JPEG 放进关键帧缓存，
> 成组时回溯挑选最多 6 张进证据包（F-028 曾整条断掉 —— 缓存没有任何产品代码写入，
> 于是"多模态调用"实际收到纯文本；现已接通并有真实浏览器回归）。
> 会话在取不到图时会**如实提示**，不静默。

契约定义全部在 `packages/contracts/`，是**唯一的事实来源**。
`packages/motion-core/` 是纯函数库，**不依赖 DOM / React / MediaPipe / 数据库 / 网络**。

---

## 7. 测试与验证

```powershell
pnpm verify         # 一把梭：typecheck → lint → format:check → audit:wiring → check:docs → test → build → check:bundle
pnpm test           # 只跑单元测试
pnpm test:e2e       # 真实浏览器端到端测试（Playwright + 真 Chrome）
```

`pnpm verify` 是**提交前门禁的唯一入口**，CI 用的就是它。

当前共 **551 项测试**（482 单元 + 69 浏览器）：

| 包 | 单元测试 | 浏览器测试 |
| --- | --- | --- |
| `@pingpong/contracts` | 32 | — |
| `@pingpong/motion-core` | 215 | — |
| `@pingpong/api` | 136 | — |
| `@pingpong/web` | 99 | 69 |
| **合计** | **482** | **69** |

**这些测试证明的是什么**：

- 几何、滤波、切分状态机、特征提取、规则判定在**构造数据**与**边界数据**上正确；
- 输出校验能拦住未审核规则、缺失值填 0、非法结构；
- **架构约束是真的生效的** —— 依赖方向、红线（不重试、不臆造）都有测试守着，
  四条违规路径逐一验证过会报 lint 错误；
- 浏览器测试用**真实 Chromium**跑，覆盖 jsdom 做不到的部分：
  真实 Canvas 像素、真实 Worker 跨线程、真实 `ImageBitmap` 句柄释放。

**这些测试不能证明什么**：

- **骨架在你的机位上是否贴合关节** —— 已在一支真实素材上目视确认贴合
  （见 `apps/web/e2e/pose-overlay.e2e.ts`），但那是**一个人、一个机位**，
  判定者还是看图模型；换成你的机位仍是独立的证据（F-006，OPEN）；
- 真实摄像头下的姿态稳定性（本机能枚举到摄像头、但**取不到流** → F-009）；
- 真实选手动作的切分准确率（分段**流水线已通**、能出指标，但缺人工标注 → 没有 precision/recall；且已知真实连续对拉会**合并相邻几板**，见 F-022）；
- 真实模型的延迟与建议质量（图片链路已接通并有回归，但**接上图片之后建议是否更好**没验过 —— 需要真实模型 Key）；
- **关键帧图片链路在真实素材上的表现** —— 编码/入包/被选中都有回归覆盖（F-028 已修），但真实拍摄下的画面质量与体积分布未实测；
- **20 分钟连续运行的稳定性**：已用合成帧实测一次（`PPC_SOAK=1`），队列无积压、吞吐不衰减，但**不是真人连续练习**；
- **手部/手指细节的可用性** —— 链路本身有三个已修的静默缺陷（F-020/F-021），
  但在这支素材上检出率只有 2/31 帧，其中一帧还是画在人脸上的**误检**
  （`known-failures.md`）。

上述几项都需要真实设备 + 真实素材，**必须在你本机实测**。
👉 按 [`docs/local-verification.md`](./docs/local-verification.md) 逐条勾选即可。
👉 功能待办与"哪些我做、哪些你做"的分工见 [`docs/roadmap.md`](./docs/roadmap.md)。


---

## 8. 排障

**`pnpm install` 报 `Unsupported engine`**
→ Node 版本低于 22.12.0，升级 Node。

**`pnpm models:fetch` 失败 / 校验不通过**
→ 脚本**不会静默回退**。检查网络；若哈希与 `models/manifest.json` 不符，
说明上游模型更新了，需人工确认后再更新 manifest 里的 `sha256`。不要绕过校验。

**Web 起来后画面黑屏、无骨架**
→ 打开 DevTools Console，看 Worker 是否加载失败。
若提示 GPU delegate 不可用，代码会自动降级到 CPU 并在 UI 上**如实标注降级**（不会假装没问题）。

**页面提示「摄像头已找到，但一直没有画面（启动超时）」**
→ 说明浏览器**枚举到了设备**、但拉不起流（Chrome 自己的超时约 10 秒）。
先跑探针把三种情况分开：

```powershell
PPC_PROBE_CAMERA=1 pnpm --filter @pingpong/web test:e2e camera-enumeration
```

它会逐个设备试开并打印结果。真实摄像头那一行失败而列表里又有一堆**虚拟摄像头**
（如 XR 头显注册的设备）时，先在界面「视频源」里换设备。
若真实摄像头也起不来，把 USB 摄像头**换个口重新插**再试 —— 实测本机出现过
"枚举得到、18 小时前还能用、现在启不动"的情况。详见 F-009。

**`/api/health` 正常但反馈报错**
→ 看 API 终端日志。一次会话只允许**一个在途模型请求**，且**不自动重试**（避免重复计费）。

**C 盘还是在变小**
→ 先看 `pnpm store path` 指向哪里。本项目实测 store 在 `E:\.pnpm-store\v10`、
`node_modules` 约 245 MB，正常情况下不会明显吃 C 盘。
→ 若 store 确实在 C 盘且空间紧张，按第 0 节把它挪到别的盘；
另外检查 `C:\Users\<你>\AppData\Local\pnpm` 是否有历史遗留缓存，可手动删除。

---

## 9. 下一步该做什么

骨架已经能编译、能测试、能跑通 mock 全链路。**接下来不是继续加功能，而是去验证假设**：

1. `pnpm models:fetch` 拉模型，真机跑起来看骨架抖动程度
2. 录 3~5 段真实正手攻球，按 `evaluation/samples.json` 的三层结构标注
3. 跑分段评估，**两步缺一不可**（`evaluation/samples.json` 的 `$howToEvaluate` 里有完整说明）：

   ```powershell
   # 3a. 导出观测：用**产品真实的 TrainingSession** 逐帧跑一遍素材
   $env:PPC_VERIFY_VIDEO="D:\path\to\clip.mp4"
   pnpm --filter @pingpong/web test:e2e segmentation-eval
   # 3b. 照着导出的联系表（每 0.25s 一格、时间戳烧在画面上）标真值，再算指标
   pnpm eval:replay --manifest evaluation/samples.json
   ```

   **没有人工标注时它会明确拒绝输出任何准确率数字** —— 没真值的指标是编造的。
4. 依据实测结果**修正**暂定阈值 —— 改 `packages/motion-core` 里这两处：
   规则阈值在 `src/rules.ts` 的 `DEFAULT_THRESHOLDS`、分段阈值在
   `src/segmentation.ts` 的 `DEFAULT_SEGMENTATION`；并同步 `configs/thresholds.json`
   （**那份不被运行时读取**，是规范快照；两边由 `thresholds-consistency.test.ts` **双向**守着一致）
5. 阈值稳定后，才考虑把知识条目的 `observation_only` 升级为可给出「合格」判定

**不要在没跑过真实数据之前调阈值。** 那样只是把猜测写进配置。

---

## 10. 工程纪律

见 `AGENTS.md`（12 条硬红线）。最核心的几条：

- 缺失值用 `null` + `reasonIfMissing`，**禁止用 0 填充**
- 只做**因果（在线）**滤波，**禁止**偷看未来帧的离线平滑
- 未审核的规则**只能**输出 `observation_only`，禁止说「合格」
- 模型输出**必须在服务端校验**，不能只靠 prompt 约束
- 命名要诚实：是 `return_after_wrist_peak_ms`，就**不要**叫 `recovery_after_impact_ms`
