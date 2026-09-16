# pingpong-coach

实时乒乓球训练反馈 MVP。**摄像头 → 自动分组挥拍 → 二维动作测量与关键帧 → 一次多模态模型调用 → 一条有证据的反馈。**

当前状态：**P0 + P1 代码骨架已完成**，工程护栏（lint/格式/CI/提交门禁）已补齐，
**386 项单元测试 + 47 项浏览器测试全部通过**。
模型调用默认为 `mock` 模式（没有真实 API Key 也能跑完整链路）。

> ⚠️ 这是一份**契约完整、可编译、可测试**的骨架，不是已验证产品。
> 所有阈值都是**暂定值**，所有评分规则都是 `observation_only`（未审核），
> 真实精度和真实延迟**尚未验证** —— 姿态链路只在本机验证到"能跑通、委托是 GPU"，
> **骨架是否贴合关节从未看过**（假摄像头下画面无人），见 F-006（仍 OPEN）。
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
pnpm verify         # 一把梭门禁（类型 + lint + 格式 + 测试 + 构建 + 体积预算）
pnpm lint           # ESLint（含架构边界约束）
pnpm lint:fix       # ESLint 自动修复
pnpm format         # Prettier 格式化
pnpm models:fetch   # 下载姿态模型到 apps/web/public/models/
pnpm eval:replay    # 回放评测（无真实标注数据时会明确拒绝输出精度数字）
pnpm clean          # 清理构建产物
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
├─ models/manifest.json     # 模型清单 + SHA-256（sha256 需实际下载后回填）
├─ evaluation/samples.json  # 三层标注样本（当前为空）
├─ scripts/                 # fetch-models、eval-replay
├─ docs/                    # spec / acceptance / data-contracts / decisions / 评测日志 / 已知失败
│                           # + roadmap（功能待办与分工）/ local-verification（本机验证清单）
├─ .github/workflows/       # CI：verify + e2e 两个 job
├─ eslint.config.mjs        # 架构护栏：依赖方向 + 红线约束（违规即报错）
└─ .husky/                  # 提交前门禁（lint-staged）
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

契约定义全部在 `packages/contracts/`，是**唯一的事实来源**。
`packages/motion-core/` 是纯函数库，**不依赖 DOM / React / MediaPipe / 数据库 / 网络**。

---

## 7. 测试与验证

```powershell
pnpm verify         # 一把梭：typecheck → lint → format:check → test → build → check:bundle
pnpm test           # 只跑单元测试
pnpm test:e2e       # 真实浏览器端到端测试（Playwright + 真 Chrome）
```

`pnpm verify` 是**提交前门禁的唯一入口**，CI 用的就是它。

当前共 **433 项测试**（386 单元 + 47 浏览器）：

| 包 | 单元测试 | 浏览器测试 |
| --- | --- | --- |
| `@pingpong/contracts` | 30 | — |
| `@pingpong/motion-core` | 169 | — |
| `@pingpong/api` | 130 | — |
| `@pingpong/web` | 57 | 47 |
| **合计** | **386** | **47** |

**这些测试证明的是什么**：

- 几何、滤波、切分状态机、特征提取、规则判定在**构造数据**与**边界数据**上正确；
- 输出校验能拦住未审核规则、缺失值填 0、非法结构；
- **架构约束是真的生效的** —— 依赖方向、红线（不重试、不臆造）都有测试守着，
  四条违规路径逐一验证过会报 lint 错误；
- 浏览器测试用**真实 Chromium**跑，覆盖 jsdom 做不到的部分：
  真实 Canvas 像素、真实 Worker 跨线程、真实 `ImageBitmap` 句柄释放。

**这些测试不能证明什么**：

- **骨架是否贴合关节**（假摄像头下画面无人，叠加层一次都没画过 → 见 F-006，仍 OPEN）；
- 真实摄像头下的姿态稳定性（本机浏览器枚举不到摄像头 → F-009）；
- 真实选手动作的切分准确率；
- 真实模型的延迟与建议质量。

上述四项都需要真实设备 + 真实素材，**必须在你本机实测**。
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
3. 跑 `pnpm eval:replay`，看切分是否命中、特征是否稳定
4. 依据实测结果**修正** `configs/thresholds.json` 里的暂定阈值
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
