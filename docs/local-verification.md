# 本地交接验证清单

**目的**：把项目从沙箱搬到你的机器后，用**可勾选、有明确预期输出**的步骤确认它真的能跑。
每一步都写明：**做什么 → 预期看到什么 → 结果记到哪**。

**怎么用**：从上往下做。每条都勾掉之后再进入下一段。
任何一步和"预期输出"不符 → 停，把实际输出记到 `docs/known-failures.md`，别绕过。

---

## 阶段 0 · 取得代码与安装

### 0.1 克隆仓库

```bash
git clone <仓库地址> pingpong-coach
cd pingpong-coach
```

**预期**：`ls` 能看到 `apps/` `packages/` `docs/` `evaluation/` `.github/` `package.json` `pnpm-workspace.yaml`。

**同时确认 `.git` 目录存在**（`.git` 是隐藏目录）：

```bash
ls -a | grep git
```

**预期**：输出 `.git` 和 `.github` 两项。

### 0.2 装 pnpm（如未装）

```bash
node -v          # 需要 >= 22.12.0
corepack enable
corepack prepare pnpm@10.28.2 --activate
pnpm -v
```

**预期**：Node 版本 ≥ **22.12.0**；`pnpm -v` 输出 **10.28.2**
（版本锁在 `package.json` 的 `packageManager` 字段里，不要用别的版本）。

### 0.3 安装依赖

```bash
pnpm install
```

**预期**：末尾出现 `Done in ...`，无 `ERR_PNPM_`。

> **注意**：仓库内 `.npmrc` 指向 `registry.npmmirror.com`。
> 这是沙箱环境（npmjs.org 被墙）留下的配置。
> **在你本机如果你有代理、想用官方源**，删掉 `.npmrc` 或改成 `registry=https://registry.npmjs.org` 都可以 —— 两边都能装。

- [ ] 安装完成，无报错

**结果记录**：______________________

---

## 阶段 1 · 一把梭验收（最重要的一步）

```bash
pnpm verify
```

这一条命令串起了 typecheck → lint → format:check → 接线审计 → 文档一致性 → 全部单测 → 构建 → 依赖体积预算。

**预期输出**（关键行，数字应当与下面一致）：

```
packages/contracts  Tests   44 passed (44)
packages/motion-core Tests 244 passed (244)
apps/api            Tests  215 passed | 1 skipped (216)
apps/web            Tests  195 passed (195)
...
✓ built in ~2s
✓ 依赖体积在预算内。
```

**预期退出码**：`0`（Windows 下可以 `echo %ERRORLEVEL%` 确认）。

> **这四行数字会随开发变化**，上面是写这份清单时的值。**权威数字只有一处**：
> 你刚跑出来的 `pnpm verify` 输出；`README.md` 与 `docs/roadmap.md` 里的分包总数
> 由 `check:docs` **交叉核对**（两者不一致时它会让 `verify` 直接失败）。
> 所以"数字和这份清单不同"本身不是问题 —— 看 `verify` 自己报的总数即可。

- [ ] `pnpm verify` 退出码为 0
- [ ] 各道门禁都过了：typecheck → lint → format → **接线审计** → **文档一致性** →
      **密钥守卫** → 全部单测 → 构建 → **依赖体积预算**（`verify` 就是按这个顺序串的）

**如果不一致**：把失败用例名贴回给我 —— 这说明你的 Node/pnpm 版本触发了沙箱里没暴露的问题，是有价值的信息。

**结果记录**：______________________

---

## 阶段 2 · 浏览器端到端测试

```bash
pnpm test:e2e
```

**预期**：`59 passed, 15 skipped`，约 40 秒（跳过的都是**按需**的探针：需要真实素材、
真实摄像头或 20 分钟时长 —— 设了对应环境变量才会跑）。

### 2.1 可选：用一段素材验证"活链路"（不需要摄像头）

**即使 F-009 让你的摄像头起不来，也能验证整条采集链路** —— Chrome 支持把
**一个视频文件当成摄像头**，于是 `getUserMedia → 流 → <video> → 调度器 →
Worker → 叠加层` 这条产品链路会跑在你的素材上：

```bash
# ① 素材转成 y4m（需要 ffmpeg）
mkdir -p apps/web/.tmp-fakecam
ffmpeg -y -i "<你的素材>" -vf "scale=640:360:flags=lanczos,fps=30" \
  -pix_fmt yuv420p -f yuv4mpegpipe apps/web/.tmp-fakecam/clip.y4m

# ② 跑（带上素材路径）
PPC_FAKE_CAMERA_Y4M="$PWD/apps/web/.tmp-fakecam/clip.y4m" pnpm test:e2e live-capture
```

**预期**：`2 passed`，且会打印两条的**出现率**，例如：

```
[live-capture] 真人画面：骨架出现率 20/20（单帧峰值 198）、准备区出现率 20/20
[live-capture] 合成图案（无人）：骨架出现率 0/20（单帧峰值 0）、准备区出现率 0/20
```

同时在 `apps/web/.tmp-fakecam/live-capture.png` 留一张现场图。

⚠️ **这个 y4m 是从你的素材转出来的，含真人画面** —— 必须放在 git 之外
（`.tmp-*/` 已被 `.gitignore` 忽略）。**不要**把它移到别的目录，更不要提交。

两条用例的分工：第一条要求"骨架在 ≥70% 的采样里出现"，
第二条（反向对照）要求无人时"<30%" —— 缺了第二条，
第一条的通过说明不了任何事。

> 为什么用**出现率**而不是"有没有像素"：合成图案上 MediaPipe 会偶发误检，
> 幅度还不小（单帧能到 57~71，而真人单帧 135~211），
> 但**幻觉是零星的、真人是持续的** —— 能分开它们的是时间占比。
> 这条反向对照还顺带量出并修掉了一个真实缺陷（F-036：同一件事实
> 两处口径不同，当时准备区圆 10/20 而骨架只有 1/20），见
> `docs/known-failures.md` F-036。

> 端到端测试会**自己起两个进程**：vite（端口 5199）和一个**真实的 API 进程**
> （端口 8788，mock 模式）。后者是为了让"前端 → 代理 → 真实后端"这条链路
> 真的走一遍（见 `e2e/integration.e2e.ts`）。所以**不必先手动启动服务**。

**首次运行可能会提示需要下载浏览器**。配置里已经写了自动探测逻辑：

1. 先找环境变量 `CHROMIUM_PATH`；
2. 再找系统 Chrome / Edge；
3. 都没有才回退 Playwright 自带的。

如果你机器上装了 Chrome/Edge，通常会直接用，**不需要额外下载**。
**如果它坚持要下载而且网络装不上**，指定一下：

```bash
# Windows Git Bash 示例
CHROMIUM_PATH="/c/Program Files/Google/Chrome/Application/chrome.exe" pnpm test:e2e
```

### 2.0 端口被占用怎么办（本机实测会撞）

e2e 会起 5 个进程，端口**可以由环境变量覆盖**。实测你这台机器上
**8891 已经被 `LZTray` / `verge-mihomo`（代理类常驻软件）占着**，
而它正好是 e2e 第 5 个进程（stage2 转发）的默认端口 ——
症状是 `Process from config.webServer was not able to start` 加一句
`EADDRINUSE 127.0.0.1:8891`。

**不要**为了跑测试去关掉你的代理软件，换个端口就行：

```bash
E2E_STAGE2_PORT=8991 pnpm test:e2e
```

各端口与对应的覆盖变量：vite `E2E_PORT`(5199)、API `E2E_API_PORT`(8788)、
live API `E2E_API_LIVE_PORT`(8789)、假模型供应商 `E2E_FAKE_MODEL_PORT`(8790)、
stage2 转发 `E2E_STAGE2_PORT`(8891)。

- [ ] 断言总数 74 项（其中 15 项按需 skip）；上面的 `59 passed` 与它对得上
- [ ] 实际使用的浏览器是：__________（Chrome / Edge / Playwright 自带）

**结果记录**：______________________

---

## 阶段 3 · 下载模型（沙箱做不了，见 F-006）

### 3.0 最省事的方式：一条命令

```bash
pnpm models:fetch
```

它会按 `models/manifest.json` 下载全部资产并**校验 sha256**：
`pose_landmarker_full.task`（约 9 MB）、`pose_landmarker_lite.task`（约 5.5 MB）、
`hand_landmarker.task`（约 7.5 MB）。

**校验失败会明确报错，不会静默换一个版本继续。** 如果 sha256 与 manifest 不符，
说明上游模型更新了 —— 需要人工确认后更新 manifest 里的 `sha256`，不要绕过校验。

- [ ] `pnpm models:fetch` 退出码 0，输出里每个文件都是 `✓`

> 下面的 3.1 / 3.2 是**手动方式**，网络受限或只想下一个模型时用；
> 正常情况下 3.0 就够了。

### 3.1 下载 Pose Landmarker 权重（手动）

**PowerShell**（推荐，Windows 上更稳）：

```powershell
New-Item -ItemType Directory -Force -Path apps\web\public\models
Invoke-WebRequest `
  -Uri "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task" `
  -OutFile "apps\web\public\models\pose_landmarker_full.task"
```

**Git Bash / WSL**：

```bash
mkdir -p apps/web/public/models
curl -L -o apps/web/public/models/pose_landmarker_full.task \
  https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task
```

**预期**：文件约 9 MB。

```bash
ls -lh apps/web/public/models/pose_landmarker_full.task
```

- [ ] 文件存在且大小在 8–10 MB 之间（太小说明下到的是错误页）

### 3.2 复制 WASM 运行时

```bash
mkdir -p apps/web/public/wasm
cp node_modules/@mediapipe/tasks-vision/wasm/* apps/web/public/wasm/
ls apps/web/public/wasm/
```

**预期**：看到 `vision_wasm_internal.js`、`vision_wasm_internal.wasm` 等文件。

- [ ] WASM 文件已复制

---

## 阶段 4 · 启动并目视验证

开两个终端。

最省事的是一条命令同时起两个：

```bash
pnpm dev:all
```

只想分开起也可以：

```bash
pnpm dev:api     # 只起后端
pnpm dev         # 只起前端
```

**预期**：后端监听 **8787**，并打印 mock 模式提示。

**自测**：

```bash
curl http://127.0.0.1:8787/api/health
```

**预期**：返回 JSON，其中 **`"modelMode": "mock"`** 是 mock 标记
（字段名是 `modelMode`，不是 `mode`）。完整响应形如：

```json
{"ok":true,"version":"0.1.0","modelMode":"mock","modelId":"mock-coach", ...}
```

- [ ] `/api/health` 返回 200 且标明 mock 模式（`modelMode` 字段）

**摄像头探针（可选，但建议先跑，省得到界面上对着一个笼统错误猜）**：

```bash
PPC_PROBE_CAMERA=1 pnpm --filter @pingpong/web test:e2e camera-enumeration
```

它会自己起一个**真实 Chrome**（不替换成假设备），打印三张结果：
枚举到几个 videoinput / **产品现在的调用方式**能不能起来 / **逐个设备**试开的结果。
这样"没有设备""有设备但起不来""只有某个虚拟摄像头不行"三种情况一眼分得开。
需要真的用摄像头，所以默认 skip，不设环境变量不会跑。

**连续运行稳定性（可选，20 分钟）**：验收里有一条"20 分钟练习无逐渐增长的任务队列或内存泄漏趋势"。
需要模型资产，且**运行期间不要编辑仓库文件**（Vite HMR 会整页重载，测试会明确报出这一点）：

```bash
PPC_SOAK=1 PPC_SOAK_MINUTES=20 pnpm --filter @pingpong/web test:e2e soak
```

默认 skip，不设环境变量不会跑。它会打印堆用量趋势、未完成帧数（队列积压代理量）、
吞吐与引擎往返延迟。实测参考值见 `docs/evaluation-log.md`。

**前端**（`pnpm dev:all` 已经包含）：

```bash
pnpm dev
```

**预期**：给出 `http://localhost:5173`。**`http://127.0.0.1:5173` 同样可用**
（vite 的 `server.host` 已显式绑 `127.0.0.1`，不会再出现"localhost 通、
127.0.0.1 连不上"这种情况）。

打开浏览器，允许摄像头权限。

### 目视检查表

站在镜头前，逐条确认：

- [ ] 视频画面正常显示，不卡顿
- [ ] **骨架贴合身体关节**（这是解锁整条链路的标志）
- [ ] 抬手、转身时骨架跟随，不脱节、不闪烁

> 上面这条（骨架贴合）**已在一支真实素材上确认过贴合**（7 个采样帧，含持拍侧手臂局部放大），
> 但那是**一个人、一个机位**、而且判定者是看图模型。你在这里做的仍然是独立证据 ——
> 你的机位、你的身体、你的光照都可能不同。
- [ ] 状态栏显示委托方式：**`GPU`** 或 `CPU`
- [ ] 若显示 `CPU`，记录原因：______________________
- [ ] 完成一次挥拍，"已记录有效挥拍"计数增长
- [ ] 挥拍后页面产生反馈（mock 模式下是预置内容）

**"本组进度"面板下方的诊断行**（排查"为什么一直等待有效挥拍"用的，逐项记下来）：

- [ ] **分段**阶段会随动作变化（空闲 → 准备区驻留 → 引拍 → 向前挥拍 → 还原）
      一直停在"空闲（等待进入准备区）"就是没识别到，看下两项
- [ ] **腕部距准备区 X 倍半径**：正常在挥拍过程中会降到 **1 以下**（进区）再升上去；
      一直 > 1 说明准备区没对上你的准备位置
- [ ] 没有 **"测不到体尺度（肩或髋未入镜）"** 警告 ——
      有就说明画面没拍到髋部，分段会**一帧都不触发**
- [ ] 没有 **"未检测到持拍手腕"** 警告
- [ ] 画面上的**绿色准备区圈**落在你手停的位置附近
      （默认是自动标定的；不符就点「以当前腕部为准备区」手动覆盖）

**"姿态引擎"面板**（在"拍摄检查"页）：

- [ ] **关键点集**显示 `blaze_33+hand_21`（手部模型加载成功）
- [ ] **手部细节**显示"可用"。

> "可用"**只表示模型加载成功**，不表示在你的素材里一定检得出、更不表示检得对。
> 实测（一支业余挥拍素材，31 帧采样）：**检出率 2/31 帧**，其中一帧的"手"
> 画在了**人脸/下巴**上 —— 是**误检**，而手部模型不提供逐点置信度，
> 下游没有能力识别或拦下它。所以在手部输出可信之前，**不要据它下任何结论**。
> 详见 `known-failures.md` 的 F-020 / F-021 与"待验证能力：手部 21 点"。

**这一步没通过 = 后面所有质量讨论都无意义。** 如果有问题，把浏览器控制台报错整段贴给我。

### 「复查」页检查表

切到顶栏的**复查**标签。这一页是**你能看见模型看见了什么**的唯一地方，
所以每一条都值得逐项看：

- [ ] **本组记录**表里有你刚完成的那一组，状态不是「无结果」
- [ ] **逐板数值与过程**：每一板**各自**一行，带它自己的测量值与**阶段转变时间线**
      （引拍开始／前挥开始／还原开始／本板闭合，各带毫秒数）
  - [ ] 时间线里的时刻与该板的时间戳**对得上**（都在该板区间内）
  - [ ] 页面明写了这些时刻**不是击球时刻**（本版没有触球事件）
- [ ] **肘角曲线（逐帧）**：能看到一条折线
  - [ ] 纵轴上下限写着角度（如 `60°`/`160°`），横轴两端写着源时间
  - [ ] 曲线上的**断口**与遮挡/出画对得上（那一段是"没测到"，**不会**被一条直线填平）
  - [ ] 说明里给出覆盖率（`共 N/M 帧测到肘角`）—— 数字明显偏低就是那一轮画质有问题
- [ ] **关键帧**：每张图下面写着`板 …`与`距事件 …ms`
  - [ ] `距事件`是**负数**的话请告诉我（那说明挑帧挑到了事件之前，是个缺陷）
- [ ] **证据包的局限**：列出了几条给模型的原话（图少了几张、哪个阶段没配上画面…）
- [ ] **回放**（只有**导入视频**时才有）：
  - [ ] 点某一板的「回放这一板」，画面**跳到该板起点**，到板尾**自动停**
  - [ ] 摄像头模式下这里会写「**这一组来自摄像头：本地链路不录制视频**」——
        这是**预期行为**，不是故障（本地链路只保留关键帧，不录像）

> 上面每一条都是「看得对不对」，不是「准不准」。**识别准不准仍然只有人工标注能回答** ——
> 复查页上的所有数字都来自同一份逐帧几何，几何本身对不对要等 P1 的标注。

### 4.1 可选：接真实大模型（不要再用 mock）

默认是 mock（不联网、也能跑通全链路）。要接真实模型，**只给 API 进程**设三个变量：

```bash
# DeepSeek 的例子（实测可用：deepseek-flash）
MODEL_API_KEY=<你的密钥> \
MODEL_BASE_URL=https://api.deepseek.com \
MODEL_ID=deepseek-flash \
pnpm dev:api
```

⚠️ **两个坑，都实测过**（`known-failures.md` F-039）：

1. **没有 `.env` 加载器** —— 往根目录放 `.env` **不会生效**，变量要真的在进程环境里。
2. **变量名没有前缀**：是 `MODEL_API_KEY`，**不是** `PPC_MODEL_API_KEY`。
   （早期 README 写的是后者，代码一个都不读 → 会**静默跑成 mock**。）

**必须确认模式**（不要靠"没报错"推断 —— 三缺一**不会**报错，只会退回 mock）：

```bash
curl http://127.0.0.1:8787/api/health
# 期望看到 "modelMode":"live"；若是 "mock"，说明变量没被读到
```

界面上也会有模式徽标：**live 与 mock 必须一眼能分辨**。

**可调项**（都有实测依据，见 `acceptance.md` 的阈值变更记录）：

| 变量 | 默认 | 什么时候要动 |
| --- | --- | --- |
| `MODEL_TIMEOUT_MS` | `15000` | 模型更慢时调大 |
| `MODEL_MAX_TOKENS` | `2000` | **看到 `model_truncated` 就调大**：推理模型先把预算花在推理上，正文会被腰斩 |

**第三方地址用哪个**：本仓库只讲 OpenAI 兼容的 `/chat/completions`。
比如 DeepSeek 要用 `https://api.deepseek.com`，
**不要**用 `https://api.deepseek.com/anthropic`（那是 Anthropic 协议，本仓库不走）。

- [ ] `/api/health` 显示 `"modelMode":"live"`
- [ ] 界面上没有 mock 徽标
- [ ] 跑一次分析，拿到的是真实模型的反馈（不是 `[mock]` 前缀的那种）
- [ ] 记下这次的真实延迟（界面上的 P95，或健康检查里的统计）

> **首次接通的实测参考**（DeepSeek `deepseek-flash`，2026-09-16）：
> 端到端 **3130~4557ms**；图片**确实到达模型**（`prompt_tokens` 35→224）；
> 模型**自发遵守红线**（`observation_only`、"腕峰≠击球时刻"、不推断发力）；
> 服务端校验实跑（`rejectedClaims: []`）。
> 完整记录见 `docs/evaluation-log.md`。

---

## 阶段 5 · 录真实素材（评估的前提）

`evaluation/` 目录目前是空的。没有真实素材，**无法回答"这个产品准不准"**。

### 拍摄建议

| 项 | 要求 |
| --- | --- |
| 机位 | 侧面或斜后方，能看到整个人和球台 |
| 高度 | 约腰高，接近水平拍摄（避免俯拍导致角度失真） |
| 光线 | 明亮均匀，避免逆光和强烈阴影 |
| 画面 | 球台完整入画，人不要贴边 |
| **肩与髋** | **必须同时入镜** —— 体尺度按"肩中点—髋中点"算，画面里看不到髋时所有阈值都没法归一化，分段会一帧都不触发 |
| **持拍手** | 至少持拍侧半身入画。更关键的是**别拍糊** —— 实测把腕部区域裁出并放大 3 倍，模糊时仍检不出，说明障碍是运动模糊而非尺寸 |
| **别拍糊** | 挥拍时手若被运动模糊糊掉，手部关键点同样检不出。提高快门或增加光照 |
| 时长 | 每次 30–60 秒，覆盖多种挥拍 |
| 数量 | 先来 5–10 段，够做第一轮评估 |

### 每段素材要记录的信息

```
文件名：
拍摄日期：
机位描述：
光线条件：
内容描述：       （例如：正手连续对拉，10 板）
我预期会看到：    （例如：肘角偏小）
```

- [ ] 已录制 ≥ 5 段素材
- [ ] 每段都填了上述信息

**素材放在哪**：**仓库外**（`evaluation/samples.json` 的 `dataPolicy` 就是这么定的，
例如 `~/pingpong-samples/`）。真实视频与任何含人脸的图**不进 Git** —— 这是数据政策，
不是"建议"。

> ⚠️ 这里原先写的是"放 `evaluation/` 下的 raw 子目录"，与政策不符，已改。
> `.gitignore` 里另外还忽略着几个**将来可能用到、现在并不存在**的目录（例如 fixtures 下
> 给真实素材预留的那个）—— 那是**兜底**，不是让你把素材往里放：视频有扩展名规则挡着，
> 但**联系表与关键帧是 PNG**，一旦落进任何会被跟踪的目录就会被 `git add` 收进去，
> 而那上面是人的脸。所以：素材放仓库外；派生出来的图放在 `.tmp-*/` 这类已忽略的临时目录里。

### 标注要标多准？先跑这个

```bash
pnpm annotate:tolerance
```

验收判据是 IoU ≥ 0.5，换算成毫秒就是**两端各偏不超过该次挥拍时长的 25%**（1.9 秒的球 → ±475 ms）。按「两端同时偏」那一列标 —— 只偏一端时容差大得多，拿它当目标会经常掉出门槛。

格子宽度**由判据推出**：800ms 的单板要求两端各标在 ±200ms 内，所以默认格子取
**100ms**（容差的一半），导出脚本会**自动自检**并打印「时长 → 容差」对照表与结论。
要改就用 `PPC_CONTACT_SHEET_STEP_MS`；基准时长用 `PPC_EXPECTED_STROKE_MS`（默认 800ms）。


### 拿到素材后：标一段，跑出第一份真实数字（三步）

工具已经全部就绪，你只需要**看联系表、填三个数字**：

```bash
# ① 导出观测 + 分块联系表 + 帧索引（时间戳烧在画面里）
PPC_VERIFY_VIDEO="<素材绝对路径>" pnpm --filter @pingpong/web test:e2e segmentation-eval

# ② 照着 strips/*.png 读时刻，填进 evaluation/samples.json 的 samples[0]
#    那里有一条**带注释的待填模板**：annotatorId + 每一板的 startMs/endMs
#    （要报事件定位再填 events）。字段名必须是 startMs/endMs —— 写错会被丢弃并告警。

# ③ 跑指标：缺标注它会**明确拒绝**给数字，而不是编一个
pnpm eval:replay --manifest evaluation/samples.json
```

输出会按**标注者**分开报（模型标注只能当估计，不许与人工真值合并），并给出
分段 precision / recall、边界误差，以及（填了 events 的话）事件时间误差 P50/P95。
**工程测试与识别质量分两栏写**：`pnpm verify` 全绿只说明代码正确，不说明识别准。

### （可选）框出准备区半径的可行区间

**沿用上面 ① 导出的 `pose-timeline.json`**（不用再跑一遍探针），只多一条命令：

```bash
pnpm diagnose:thresholds --timeline apps/web/.tmp-eval/pose-timeline.json
```

它把「腕部到准备区中心的距离」画成分布：若有**两个足够大的峰**，就取两峰之间的
谷底当分界，给出「可行区间」；若分布是单峰（对拉时常见），它会**明说"没找到显著的
谷底"并拒绝给建议值**。这是刻意的：谷底不显著时硬给一个数，等于换个方式猜。

⚠️ **它不改任何阈值**。改阈值要按 `docs/acceptance.md` 记录理由与版本，
且**样本量只有一两段素材时不足以定值** —— 这时该做的是**人工标注**，不是调参。

**① 会输出什么（事实，不是评价）**：逐帧人体检出数、闭合了几次挥拍 / 几组。
它**不会**输出准确率 —— 没有人工标注就没有真值，`eval:replay` 在缺标注时
会明确拒绝输出数字（这是设计，不是缺陷）。

- [ ] 已跑通回放探针（`apps/web/.tmp-eval/` 下有 `segmentation-observed.json`、
      `pose-timeline.json`、`strips/`、`frame-index.json`）
- [ ] 已照联系表填好 `samples.json` 里那条模板（至少一板 + `annotatorId`）
- [ ] `pnpm eval:replay` 输出了分段指标（而不是"未计入"）
- [ ] （可选）跑了阈值诊断，并把输出贴回来

---

## 阶段 6 · 反馈回来给我

做完以上，把这些带回来：

| 要带的东西 | 从哪来 |
| --- | --- |
| `pnpm verify` 的实际输出 | 阶段 1 |
| `pnpm test:e2e` 的结果与所用浏览器 | 阶段 2 |
| 目视检查表的每一项结果 | 阶段 4 |
| 委托方式是 GPU 还是 CPU | 阶段 4 |
| 真实素材 + 每段的元信息 | 阶段 5 |
| **你觉得别扭的地方** | 阶段 4 操作时的直觉 |

最后一项最重要。**"逻辑对但感觉怪"的地方，就是这轮交接最值钱的产出。**

---

## 附：常用命令速查

| 命令 | 作用 |
| --- | --- |
| `pnpm verify` | 全量门禁（类型 + lint + 格式 + 接线审计 + 文档一致性 + 测试 + 构建 + 体积预算） |
| `pnpm test` | 只跑单测 |
| `pnpm test:e2e` | 只跑浏览器测试 |
| `pnpm lint:fix` | 自动修 lint |
| `pnpm format` | 自动格式化 |
| `pnpm build` | 构建全部 |
| `pnpm models:fetch` | 下载并校验姿态模型权重 |
| `pnpm eval:replay` | 回放评测（缺人工标注时拒绝输出精度数字） |
| `pnpm diagnose:thresholds` | 阈值诊断：框出准备区半径的可行区间（见阶段 5） |
| `pnpm --filter @pingpong/web dev` | 只起前端 |
| `pnpm --filter @pingpong/api dev` | 只起后端 |

## 附：遇到问题怎么办

1. **先看 `docs/known-failures.md`** —— 已记录的坑大概率就在里面；
2. 是新问题 → 按「失败分类口径」表归类，记到该文件；
3. 同一问题**先限定两轮**有证据的修复；仍不通就记录原因、换路径。

**不要**无限调 prompt，**不要**悄悄降低验收条件。
