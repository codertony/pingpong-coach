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
| `@pingpong/api` | 28 | **135** | +107（知识筛选、去重 TTL、prompt 缺失值、provider 不重试、analyze 状态码、模糊、mock 按关注点回答） |
| `@pingpong/web`（单元） | 37 | **64** | +27（组件渲染、摄像头错误映射、配色对比度、60fps 调度、延迟口径） |
| `@pingpong/web`（浏览器） | 0 | **54** | +54（真实 Canvas 像素、真实 Worker、真实 ImageBitmap、前后端真实串联 + 红线 8 服务端校验、摄像头故障、镜像开关、解剖比例自检、手部模型契约） |
| **合计** | 172 | **459** | **+287** |

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
> 测试从 172 涨到 471，但**增量几乎全部落在"代码正确性"**上。
> 关于"这个产品准不准"的结论，一项目前都没有增加 —— 那需要真实素材，见 `docs/roadmap.md`。

---

## 2026-09-16 · 真实素材上的人工实测（骨架叠加 / 手部链路）

### 环境（事实）

| 项 | 值 |
| --- | --- |
| 素材 | 一支手机拍摄的业余正手练习片段，1280×720 / HEVC / 30fps / 8.13s / 244 帧 |
| 素材位置 | 仓库之外（`.gitignore` 覆盖，见 `docs/data-contracts.md`），由 `PPC_VERIFY_VIDEO` 传入 |
| 推理 | MediaPipe Pose Landmarker full + Hand Landmarker，均为 **GPU 委托** |
| 浏览器 | 本机 Windows 11 + 真实 Chromium（非容器） |

> 样本量为 **1 支素材、1 个人、1 个机位**。下面所有数字都**不能**外推。

### 骨架叠加的目视检查（事实）

把**产品自己的** `drawSkeleton` 画在 7 个采样帧上并逐张看
（`apps/web/e2e/pose-overlay.e2e.ts`，图像写到 `PPC_OVERLAY_OUT` 指向的目录）：

| 项 | 实测 |
| --- | --- |
| 人体育检出 | **7 / 7** 帧 |
| 叠加层是否真画出东西 | 7/7（6976 ~ 9398 非透明像素）|
| 最低可见度范围 | 0.09（1s）~ 0.89（6s）|

**观察**：

- 高置信度帧（6s）：鼻尖落在鼻子上；**持拍侧（蓝）肩→肘→腕整条链贴着右臂
  一直走到握拍手**；髋与腿链条贴住；左右标签正确（面向镜头时人物自己的右侧
  出现在画面左边）。
- 低置信度帧（1s，最低可见度 0.09）：侧面机位，**琥珀色（低置信度）段
  落在真正被遮挡的远侧躯干上**，不是随机乱飘；持拍臂链条有约 20~30px 偏移。

**判读（推测）**：骨架贴合关节，且置信度与遮挡一致。但判定者是**看图模型**
不是人，20px 偏差在 1280 宽画面里只有 1.5%，接近该判读方式的分辨下限。

### 手部链路的实测（事实）

| 项 | 实测 |
| --- | --- |
| 手部检出率（31 帧采样，步长 0.25s） | **2 / 31 帧**（t≈3.0s、t≈6.25s）|
| 检出时手的包围盒对角线 | 约 **91 px**（画面宽 1280）|
| 容差（产品取值 `hypot(W,H)*0.15`） | 220 px |
| 按产品当时口径成功分配 | **0 / 31 帧** |
| 把点换算到与锚点同一空间后分配 | **2 / 31 帧** |
| 被丢弃时的距离 | 625 ~ 712 px |

**结论**：F-020（单位口径）成立且可复现；修好后手部点确实产出并画出。
但 t≈6.25s 那一帧的"手"**画在人脸/下巴上，是误检** —— 而手部模型
**不提供逐点置信度**，下游无法识别。因此**手部输出目前不可信**，
不得作为任何结论的依据。

### 本轮新发现的真实缺陷（事实）

| 编号 | 位置 | 缺陷 | 严重度 |
| --- | --- | --- | --- |
| F-020 | `apps/web/src/vision/pose.worker.ts` | 手部点（归一化）与腕部锚点（像素）不在同一空间 → 每只手每帧都被静默丢弃，而 `handDetected` 仍为 `true` | 高（静默 + 遥测反向误导）|
| F-021 | `apps/web/src/training/skeleton-overlay.ts` | ① `drawHand` 拼的名字在契约里不存在 → 从未执行过；② 通用关键点循环又按姿态尺寸重画手部点 → 21 点糊成一团白 | 高（功能等于没接）|
| — | `apps/web/e2e/canvas.e2e.ts` | `rightHandPoints()` 用了与缺陷代码**同一个错名字**，导致该组测试一直在量通用循环的像素却报成"手部绘制通过" | 中（测试与被测代码共用错误假设）|

### 未验证项（相较上轮的变化）

| 项 | 上轮 | 本轮 |
| --- | --- | --- |
| 骨架是否贴合关节 | ❌ 从未看过 | 🟡 **一支素材、一个机位、看图模型判定：贴合**。你的机位仍未验（F-006 保持 OPEN）|
| 手部检出率 | ❌ 未验证 | 🟡 **已量出：2/31 帧**；正确率仍无数据，且已观察到误检 |
| 真实挥拍分段准确率 | ❌ 未验证 | ❌ 仍未验证（无人工标注 → B4）|
| 真实摄像头采集 | ❌ 未验证 | ❌ 仍未验证（F-009，环境问题）|
| 二维肘角真实 MAE / 端到端延迟 / 模型质量 / 20 分钟稳定性 | ❌ 未验证 | ❌ 仍未验证 |

> **本轮最重要的一句话**：这一轮没有增加任何"识别准不准"的证据，
> 但**把三个静默失效变成了可见的、有回归的缺陷** ——
> 而它们此前全都伪装成"正常"。

---

## 2026-09-16 · 摄像头可用性探针（F-009，第二轮）

### 方法（事实）

新增 `apps/web/e2e/camera-enumeration.e2e.ts`，`PPC_PROBE_CAMERA=1` 开启（默认 skip → CI 不受影响）。
它**自己起浏览器**，绕开项目里那条 `--use-fake-device-for-media-stream`
（该开关会把真实摄像头换成假设备，在它下面永远测不出真实可用性），
只保留自动接受权限弹窗。三个阶段：未授权枚举 / 按产品现在的写法取流 / 逐设备精确试开。

探针的每设备超时可调（`PPC_CAMERA_TIMEOUT_MS`）——**这一点是必要的**：
第一版固定 8 秒，真实摄像头报超时，我一度以为是冷启动慢；
调到 30 秒复测，它仍在 **10.0 秒**处失败 ⇒ 那是 **Chrome 自己的设备启动超时**，
"慢"这个解释被排除。

### 结果（事实，真实 Chrome）

| 阶段 | 结果 |
| --- | --- |
| A. 未授权枚举 | **5** 个 videoinput |
| B. 产品现在的调用方式（默认设备）| ❌ `AbortError: Timeout starting video source`（10.0s）|
| C. 逐设备试开 | `HIK 2K USB CAMERA` ❌ `AbortError`（10.0s）；`Meta Quest 2/3/3S/Pro` ❌ `NotReadableError`（10~700ms）|

> **阶段 A 的 caveat**：`--use-fake-ui-for-media-stream` 可能让 Chrome 一开始就当权限已授予，
> 于是 A 实际测到的是"已授权"状态。本机 A 返回 5 个设备且 `deviceId` / `label` 均非空，
> 但**不能**据此断言普通 Chrome 未授权时也拿得到 `deviceId`。该结论不影响任何现有实现，
> 未进一步验证。

### 排除项（事实，均为本机实测）

| 假设 | 依据 |
| --- | --- |
| 没有摄像头 | 真实 Chrome 枚举到 **5** 个 videoinput |
| 被其它进程占用 | FrameServer / FrameServerMonitor 均 `Stopped`；ConsentStore 里最后一次会话 `stop` 已有值 |
| 系统隐私开关 / 浏览器权限 | 显式 `grantPermissions(['camera'])` 后逐设备试开仍全部失败 |
| 只是"慢"（冷启动） | 超时调到 30s，仍在 Chrome 自身的 10.0s 处失败 |
| 桌面浏览器被换成 WebView | 本轮用的就是真实 Chrome（`chrome.exe`），不是 WebView |

### 一个时间线证据（事实）

注册表 `ConsentStore\webcam` 里 `chrome.exe` 有一次**成功**的会话：
**2026-09-16 01:10:19 ~ 01:11:06**，与第一轮"用相同约束打开成功 1280×720@30"对得上。
⇒ **同一台机器、同一个摄像头，18 小时前能用，现在起不来。**

### 判读（推测）

USB 摄像头进入了需要**重新插拔 / 断电重连**才能恢复的状态。
PnP 里状态仍是 `OK`，设备管理器看不出异常 —— 这类"枚举得到、启不动"的形态常见于此。

**注意两种失败不要混为一谈**：第一轮在界面里看到的是 **0 个设备 + `NotFoundError`**
（更像非桌面浏览器环境），本轮是 **5 个设备 + `AbortError`**（设备启动失败）。
它们是两件不同的事。

### 顺带修掉的代码问题（事实）

`describeCameraError` 原先没有 `AbortError` / `TimeoutError` 分支，本次这个失败会落到兜底文案：
把浏览器英文原文端给用户，建议只有"可以改用导入视频继续验证链路"。
现单列分支说明"设备在列表里、但一直没画面"并给出四个可操作方向。
回归 `apps/web/test/capture-source.test.ts` 2 项，用实测原文钉住
"不得把英文原文当文案、建议必须具体"。

### 下一步（只有用户能做）

换一个 USB 口重新插摄像头，重跑探针；真实摄像头那行变 ✅ 即恢复。

---

## 2026-09-16 · 分段评估流水线接通 + 第一组真实分段观测

### 背景：此前 `eval:replay` 是个空壳（事实）

`pnpm eval:replay` 原先只做**清单校验与结构检查**，脚本自己写着"评估流水线尚未接入"，
而 README 第 9 节却让用户"跑它看切分是否命中" —— 那是句做不到的话。
本轮把它接通了。

### 做了什么（事实）

| 部件 | 位置 | 作用 |
| --- | --- | --- |
| 观测导出 | `apps/web/e2e/segmentation-eval.e2e.ts`（需 `PPC_VERIFY_VIDEO`，默认 skip）| 用**产品真实的 `TrainingSession`** 逐帧跑完整段素材 |
| 指标计算 | `packages/motion-core/src/segmentation-metrics.ts` | temporal IoU 配对、precision / recall、边界误差 |
| 指标单测 | `packages/motion-core/test/segmentation-metrics.test.ts` | **18 项**，针对"容易被做手脚"的每一处各钉一条 |
| 评估入口 | `scripts/eval-replay.ts`（由 `tsx` 运行）| 读清单 → 配对 → 出报告；**缺人工标注则拒绝输出任何数字** |

**为什么观测要走浏览器里的真会话**：`StrokeSegmenter` 收的是**已滤波**的腕部位置、
已算好的体尺度与质量，那些前处理在 `TrainingSession` 里。要在 Node 复现就得抄一份，
而"同一个事实两处各写各的"正是本项目反复出问题的形态（F-017/F-018/F-019）。
所以反过来：在浏览器里用真会话跑，只导出结果。
配套把会话配置抽成 `apps/web/src/training/session-config.ts`，两边（App 与评估）同源。

### 第一组真实观测（事实）

素材：1280×720 / 8.15s / 30fps / 244 帧，逐帧喂入。

| 项 | 实测 |
| --- | --- |
| 人体逐帧检出 | **244 / 244** |
| 准备区自动标定 | 成功 |
| 检出的挥拍 | **1 次**（窗口 1267 ~ 3167 ms）|
| 结束原因 | `stroke_too_long` |

逐帧相位日志显示，**在这一条 StrokeEvent 内部**：

```
ready@833 → backswing@1333 → forward@1733 → returning@1867
          → backswing@1933 → forward@2067 → returning@2367
          → backswing@2500 → forward@2833 → returning@3033 → ready@3167
```

`backswing→forward→returning` 循环**三遍**才回到 ready；3.3s 之后相位在
`idle ↔ ready` 之间反复横跳，再没进过 backswing。

### 判读（推测，需人工标注确认）

**连续对拉时相邻几板被合并成一次挥拍 —— 是少算，不是多算。**
最可能的原因是 `returnStableMinMs = 120` 要求"回到准备区并稳定驻留 120ms"，
而真实连续对拉里手并没有在两次挥拍之间停留（日志里 `returning@1867 → backswing@1933`
只隔 **66ms**）。阈值从未在真实素材上校准过。

### 为什么**没有**顺手改阈值（这一条是纪律，不是遗漏）

没有真值时调参只是把猜测从一个值挪到另一个值。README 第 9 节写的就是这件事。
评估流水线已接通，缺的只是**人工标注** —— 那一步只有人能做，
因为用算法自己的信号去标真值就是循环论证。

### 一件没做成的事（如实记）

我原计划**自己**照着联系表把真值标出来。做到一半判断做不了：
联系表是每 0.25s 一格，而这段素材是**近乎连续的对拉** ——
能看出"他在挥拍"，但**判不出每一板的起止边界**，而 IoU ≥ 0.5 的判定需要的正是边界。
硬标出来的数字不会通过任何人的复核，只会变成一个看起来很专业的假数字。
所以本节**不给 precision / recall** —— 这正是 `eval:replay` 拒绝输出数字的同一个理由。

### 未验证项（相较上轮的变化）

| 项 | 上轮 | 本轮 |
| --- | --- | --- |
| 真实挥拍分段准确率 | ❌ 未验证 | 🟡 **流水线已通、已能出指标**；缺人工标注 → 仍无 precision/recall。**观测层面已量出"3 遍循环并成 1 次挥拍"** |
| 其余（摄像头、肘角 MAE、端到端延迟、模型质量、20 分钟稳定性）| ❌ 未验证 | ❌ 仍未验证 |
