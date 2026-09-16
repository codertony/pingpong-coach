# 实测记录

用途：硬件、版本、数据集、运行命令、实测结果。
**分别说明事实、推测和未验证项。**

---

## 2026-09-15 · 代码骨架与自动化测试

### 环境（事实）

| 项目 | 值 |
| --- | --- |
| 运行位置 | 开发沙箱（Linux 容器），**非**目标练习设备 |
| Node | v22.13.1 |
| pnpm | 10.28.2 |
| TypeScript | 5.9.3 |
| Vitest | 2.1.9 |
| Vite | 6.4.3（web）/ 5.4.21（vitest 传递依赖） |
| Fastify | 5.12.4 |
| Zod | 3.25.76 |
| React | 18.3.1 |
| @mediapipe/tasks-vision | 0.10.35 |

> 以上均为 `pnpm install` 后**实际解析到**的版本（非 `package.json` 里的 `^` 范围）。

> 方案建议 Node 24 LTS 作为初始候选。此处实际验证到的是 Node 22.13.1；
> **目标设备安装后需重新验证兼容性**，不要把沙箱版本直接当作已验证结论。

### 已实际运行的验证（事实）

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| 依赖安装 | `pnpm install` | 成功 |
| 契约类型检查 | `pnpm --filter @pingpong/contracts typecheck` | 通过 |
| 契约测试 | `pnpm --filter @pingpong/contracts test` | 12/12 通过 |
| 计算核心类型检查 | `pnpm --filter @pingpong/motion-core typecheck` | 通过 |
| 计算核心测试 | `pnpm --filter @pingpong/motion-core test` | 95/95 通过 |
| Web 类型检查 | `pnpm --filter @pingpong/web typecheck` | 通过 |
| Web 测试 | `pnpm --filter @pingpong/web test` | 37/37 通过 |
| Web 生产构建 | `pnpm --filter @pingpong/web build` | 成功，worker 独立分包 |
| API 类型检查 | `pnpm --filter @pingpong/api typecheck` | 通过 |
| API 测试 | `pnpm --filter @pingpong/api test` | 28/28 通过 |
| API 真实 HTTP 启动 | `PORT=8791 pnpm start` + curl | `GET /api/health` 与 `POST /api/coach/analyze` 均正常返回 |

构建产物：`index-*.js` 262.89 kB（gzip 79.46 kB）、`pose.worker-*.js` 126.85 kB、CSS 4.34 kB。

#### 根目录全量复跑（事实）

在仓库根目录一次性跑完整链路，确认多包协同无问题：

| 命令 | 结果 |
| --- | --- |
| `pnpm install` | 4 个 workspace 包 + 根，成功（esbuild postinstall 已放行） |
| `pnpm typecheck` | contracts / motion-core / api / web **全部通过** |
| `pnpm test` | **172 / 172 通过**（12 + 95 + 28 + 37） |
| `pnpm build` | api 类型检查通过；web 生产构建成功 |

#### 真实 HTTP 端到端验证（事实）

启动 API（`PPC_PORT=8791 pnpm start`），用 `fetch` 发送一份符合契约的完整证据包：

**`GET /api/health`**

```json
{"ok":true,"version":"0.1.0","modelMode":"mock","modelId":"mock-coach",
 "ruleVersion":"1.0.0","knowledgeVersion":"1.0.0","nodeVersion":"v22.13.1"}
```

**`POST /api/coach/analyze`**（1 次挥拍、3 张关键帧、1 个缺失特征）

返回 HTTP 200，关键字段：

| 字段 | 值 |
| --- | --- |
| `status` | `observation_only` |
| `mock` | `true` |
| `modelId` | `mock-coach` |
| `evidenceRefs` | `["return_after_wrist_peak_ms", "kf-1"]` |
| `serverElapsedMs` | `1` |
| `cue` | `null` |

**校验拒绝路径也已验证**：故意发送字段名错误的证据包，API 返回
`HTTP 400` + `code: "unsupported"`，并逐条列出契约违规字段
（`strokes.0.strokeId: Required` 等）。说明**输入侧校验是真实生效的**，
不是只写在文档里。

**去重路径已验证**：同一 `requestId` 重复提交返回 `deduplicated: true`；
更换 `requestId` 后返回 `deduplicated: false`。

**日志无异常**：整个会话 6 次 200 + 1 次 400（故意的负例），
唯一的 warn 是启动时如实播报的 mock 模式提示。

> ⚠️ **`serverElapsedMs: 1` 是 mock 值的耗时，绝不能被当作真实模型延迟。**
> 它只证明「请求进得来、校验跑得通、响应出得去」。

### 几何计算的实测确认（事实）

在 1280×720 画面下构造已知真实角度，验证长宽比修正：

| 真实角度 | 直接用归一化坐标 | 乘回原图宽高后 |
| --- | --- | --- |
| 45° | 60.642° | 45.000° |
| 60° | 72.008° | 60.000° |
| 135° | 偏差 > 1° | 135.000° |
| 轴向直角 90° | 90.000°（不失真） | 90.000° |

**结论**：非轴向角度的失真可达 12 度以上，远超 10° MAE 验收门槛，因此强制修正。

### 未验证项（关键）

以下**全部未经实测**，不得在对外说明中当作已达成：

- ❌ 真实摄像头采集与 MediaPipe 姿态推理（沙箱无摄像头）
- ❌ GPU 委托在目标浏览器 Worker 中的可用性
- ❌ 真实挥拍的分段准确率（precision / recall / IoU）
- ❌ 二维肘角在真实动作上的 MAE
- ❌ 端到端延迟（姿态处理 P95、本组反馈 P95）
- ❌ 真实多模态模型调用的质量、延迟与费用
- ❌ 20 分钟连续运行的内存与队列稳定性
- ❌ 手机通过局域网访问的摄像头可用性
- ❌ Windows / Chrome 下的实际行为

**因此：`configs/thresholds.json` 中所有性能与质量数字都是拟定目标，不是实测值。**
`docs/acceptance.md` 中所有验收项状态均为「未测」。

### 推测（需实验确认）

- 若目标设备实测处理频率低于约 25 FPS，细粒度时序结论将不可靠；可能需要改用 `pose_landmarker_lite` 或收窄目标。
- 首版 `observation_only` 规则意味着用户暂时**得不到**"达标/未达标"的明确判断，只有测量结果。这是有意的安全选择，但可能影响首版可用性感受，需在 P1 试用后评估。

### 需要 P0 补充的具体信息

- 实际开发和练习电脑的操作系统、CPU/GPU、浏览器
- 计划使用的摄像头、分辨率、真实帧率与机位
- 同一机位下几段定点正手视频及其可见性
- 可用视觉模型接口及其真实响应时间
- 本组准备区域或教练认可的目标参考
- 用户可接受的语音频率、每组挥拍数量、是否需要训练中完整录像

---

## 2026-09-15 · 工程护栏补齐 + 测试扩容（第二轮）

### 环境（事实）

| 项目 | 值 |
| --- | --- |
| 运行位置 | 云端开发沙箱（腾讯云 Cloud Studio，Ubuntu 24.04 Docker 容器） |
| 内核 | `6.6.117-45.11.3.tl4.x86_64`（`.tl4` = 腾讯内核标识） |
| Node | v22.13.0 |
| TypeScript | 5.9.3 |
| Vitest | 2.1.9 |
| ESLint | 9.39.4（flat config） |
| Prettier | 3.9.6 |
| Playwright | 使用**系统 Chromium 144**（非 Playwright 自带浏览器） |

### 本轮新增的工程护栏（事实）

| 项 | 内容 | 是否验证过 |
| --- | --- | --- |
| ESLint 9 flat config | 依赖方向 + 红线约束 | ✅ 四条违规路径逐一确认会报错 |
| `eslint-plugin-boundaries` | 跨模块依赖限制 | ✅ |
| `no-restricted-imports` | 跨包裸标识符限制（boundaries 匹配不到裸包名，这是必要补充） | ✅ |
| Prettier + `.prettierignore` | 统一格式 | ✅ `--check` 通过 |
| husky + lint-staged | 提交前自动 lint + format | ✅ hook 已装 |
| GitHub Actions CI | `verify` + `e2e` 两个 job | ✅ 配置就绪（未在真实 CI 上跑过） |
| `pnpm verify` | 一键门禁 | ✅ 退出码 0 |

### 测试扩容（事实）

| 包 | 上轮 | 本轮 | 增量 |
| --- | --- | --- | --- |
| `@pingpong/contracts` | 12 | **27** | +15（版本常量一致性、枚举与 schema 同步） |
| `@pingpong/motion-core` | 95 | **176** | +81（退化几何、CV 边界、NaN 约定、准备区标定、手部几何与可见性、肘角伸展） |
| `@pingpong/api` | 28 | **130** | +102（知识筛选、去重 TTL、prompt 缺失值、provider 不重试、analyze 状态码、模糊） |
| `@pingpong/web`（单元） | 37 | **64** | +27（组件渲染、摄像头错误映射、配色对比度、60fps 调度、延迟口径） |
| `@pingpong/web`（浏览器） | 0 | **54** | +54（真实 Canvas 像素、真实 Worker、真实 ImageBitmap、前后端真实串联 + 红线 8 服务端校验、摄像头故障、镜像开关、解剖比例自检、手部模型契约） |
| **合计** | 172 | **454** | **+282** |

### 全量复跑结果（事实）

```
pnpm verify  →  退出码 0
  contracts      27 passed
  motion-core   141 passed
  api           127 passed
  web (vitest)   37 passed
  （build 成功，web 产物 index-*.js 262.88 kB / gzip 79.45 kB）
pnpm test:e2e  →  36 passed (10.3s)
```

### 本轮新发现的真实缺陷（事实）

不是测试写错，是代码本身的问题：

| 位置 | 缺陷 | 严重度 |
| --- | --- | --- |
| `motion-core/src/features.ts` | `computeElbowTorsoDrift` 解构出 `reason` 后丢弃，硬编码 `reasonIfMissing: null`。质量降级为 `limited` 时调用方看不到任何解释，违反红线 1 | 中（静默降级） |
| `contracts/src/feature.ts` | `featureSetSchema` 硬编码 `z.literal("1")`，与 `schemaVersionSchema` 双份维护，改一处会漂移 | 中 |
| `contracts/src/evidence.ts` | `strokeType` 重复定义字面量，未复用 `primitives.strokeTypeSchema` | 低 |
| `web/src/training/training-session.ts` | 未使用的 `SpeechChannel` 导入 | 低 |
| `web/src/ui/App.tsx` | 未使用的 `monotonicNow` 导入 | 低 |

### 网络受限的实测边界（事实 —— 重要）

沙箱的域名白名单是**真实存在**的，实测结果：

| 域名 | 可达性 |
| --- | --- |
| `registry.npmmirror.com` | ✅ 可达（因此 `.npmrc` 指向它） |
| `cdn.jsdelivr.net` | ✅ 可达 |
| `unpkg.com` | ✅ 可达 |
| `storage.googleapis.com` | ❌ **不可达**（DNS 解析到 `198.18.0.14`，TLS 报 `SSL_ERROR_SYSCALL`） |
| `github.com` | ❌ 不可达 |
| `huggingface.co` | ❌ 不可达 |
| `registry.npmjs.org` | ❌ 不可达 |

**直接后果**：MediaPipe Pose Landmarker 的 `.task` 权重托管在 `storage.googleapis.com`，
因此**沙箱内从未跑过一次真实的姿态推理**。这被记录为 **F-006（OPEN）**。

### 未验证项（相较上轮的变化）

上轮列出的 9 项未验证项，本轮**只消除了其中一部分**，必须如实区分：

| 项 | 上轮 | 本轮 |
| --- | --- | --- |
| GPU 委托在 Worker 中的可用性 | ❌ 未验证 | 🟡 **协议层已测**（9 个用例覆盖降级上报），**硬件层仍未验证** |
| 浏览器内 Canvas / Worker / ImageBitmap 行为 | ❌ 未验证 | ✅ **已用真实 Chromium 验证**（36 项） |
| 真实摄像头采集与姿态推理 | ❌ 未验证 | ❌ **仍未验证**（且沙箱内不可能验证 → F-006） |
| 真实挥拍分段准确率 | ❌ 未验证 | ❌ 仍未验证 |
| 二维肘角真实 MAE | ❌ 未验证 | ❌ 仍未验证（仅构造数据验证） |
| 端到端延迟 | ❌ 未验证 | ❌ 仍未验证 |
| 真实多模态模型调用质量/延迟/费用 | ❌ 未验证 | ❌ 仍未验证（mock 路径已测） |
| 20 分钟连续运行稳定性 | ❌ 未验证 | ❌ 仍未验证 |
| 手机局域网访问 | ❌ 未验证 | ❌ 仍未验证 |
| Windows / Chrome 实际行为 | ❌ 未验证 | ❌ 仍未验证（沙箱是 Linux + Chromium 144） |

> **本轮最重要的一句话**：
> 测试从 172 涨到 454，但**增量几乎全部落在"代码正确性"**上。
> 关于"这个产品准不准"的结论，一项目前都没有增加 —— 那需要真实素材，见 `docs/roadmap.md`。
