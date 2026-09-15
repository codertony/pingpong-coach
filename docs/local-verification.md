# 本地交接验证清单

**目的**：把项目从沙箱搬到你的机器后，用**可勾选、有明确预期输出**的步骤确认它真的能跑。
每一步都写明：**做什么 → 预期看到什么 → 结果记到哪**。

**怎么用**：从上往下做。每条都勾掉之后再进入下一段。
任何一步和"预期输出"不符 → 停，把实际输出记到 `docs/known-failures.md`，别绕过。

---

## 阶段 0 · 解压与安装

### 0.1 解压

```bash
cd /d/Workspace          # 你的 D 盘
unzip pingpong-coach.zip -d .
cd pingpong-coach
```

**预期**：`ls` 能看到 `apps/` `packages/` `docs/` `evaluation/` `.github/` `package.json` `pnpm-workspace.yaml`。

**同时确认 `.git` 目录存在**（`.git` 是隐藏目录）：

```bash
ls -a | grep git
```

**预期**：输出 `.git` 和 `.github` 两项。若只有 `.github`，说明压缩包丢了 Git 历史，记一笔。

### 0.2 装 pnpm（如未装）

```bash
node -v          # 需要 >= 20
corepack enable
corepack prepare pnpm@9 --activate
pnpm -v
```

**预期**：Node 版本 ≥ 20；`pnpm -v` 输出 9.x。

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

这一条命令串起了 typecheck → lint → format:check → 全部单测 → 构建 → 依赖体积预算。

**预期输出**（关键行，数字必须一致）：

```
packages/contracts  Tests  30 passed (30)
packages/motion-core Tests 145 passed (145)
apps/api            Tests 130 passed (130)
apps/web            Tests  51 passed (51)
...
✓ built in ~2s
✓ 依赖体积在预算内。
```

**预期退出码**：`0`（Windows 下可以 `echo %ERRORLEVEL%` 确认）。

- [ ] `pnpm verify` 退出码为 0
- [ ] 四组测试数字与上面完全一致（总共 356）

**如果不一致**：把失败用例名贴回给我 —— 这说明你的 Node/pnpm 版本触发了沙箱里没暴露的问题，是有价值的信息。

**结果记录**：______________________

---

## 阶段 2 · 浏览器端到端测试

```bash
pnpm test:e2e
```

**预期**：`38 passed`，耗时至多 1 分钟。

**首次运行可能会提示需要下载浏览器**。配置里已经写了自动探测逻辑：

1. 先找环境变量 `CHROMIUM_PATH`；
2. 再找系统 Chrome / Edge；
3. 都没有才回退 Playwright 自带的。

如果你机器上装了 Chrome/Edge，通常会直接用，**不需要额外下载**。
如果它坚持要下载而且网络装不上，指定一下：

```bash
# Windows Git Bash 示例
CHROMIUM_PATH="/c/Program Files/Google/Chrome/Application/chrome.exe" pnpm test:e2e
```

- [ ] 38 项全部通过
- [ ] 实际使用的浏览器是：__________（Chrome / Edge / Playwright 自带）

**结果记录**：______________________

---

## 阶段 3 · 下载模型（沙箱做不了，见 F-006）

### 3.1 下载 Pose Landmarker 权重

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

**终端 A —— 后端**：

```bash
pnpm --filter @pingpong/api dev
```

**预期**：监听端口（默认 3000 上下），并打印 mock 模式提示。

**自测**：

```bash
curl http://localhost:3000/api/health
```

**预期**：返回 JSON，含 `mode: "mock"` 之类的明确标记。

- [ ] `/api/health` 返回 200 且标明 mock 模式

**终端 B —— 前端**：

```bash
pnpm --filter @pingpong/web dev
```

**预期**：给出 `http://localhost:5173` 之类的地址。

打开浏览器，允许摄像头权限。

### 目视检查表

站在镜头前，逐条确认：

- [ ] 视频画面正常显示，不卡顿
- [ ] **骨架贴合身体关节**（这是解锁整条链路的标志）
- [ ] 抬手、转身时骨架跟随，不脱节、不闪烁
- [ ] 准备区提示圈显示在合理位置
- [ ] 状态栏显示委托方式：**`GPU`** 或 `CPU`
- [ ] 若显示 `CPU`，记录原因：______________________
- [ ] 走进/走出准备区，页面有对应提示
- [ ] 完成一次挥拍，页面产生反馈（mock 模式下是预置内容）

**这一步没通过 = 后面所有质量讨论都无意义。** 如果有问题，把浏览器控制台报错整段贴给我。

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

**素材放在哪**：`evaluation/` 目录下，建议 `evaluation/raw/`。

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
| `pnpm verify` | 全量门禁（类型 + lint + 格式 + 测试 + 构建） |
| `pnpm test` | 只跑单测 |
| `pnpm test:e2e` | 只跑浏览器测试 |
| `pnpm lint:fix` | 自动修 lint |
| `pnpm format` | 自动格式化 |
| `pnpm build` | 构建全部 |
| `pnpm --filter @pingpong/web dev` | 只起前端 |
| `pnpm --filter @pingpong/api dev` | 只起后端 |

## 附：遇到问题怎么办

1. **先看 `docs/known-failures.md`** —— 已记录的坑大概率就在里面；
2. 是新问题 → 按「失败分类口径」表归类，记到该文件；
3. 同一问题**先限定两轮**有证据的修复；仍不通就记录原因、换路径。

**不要**无限调 prompt，**不要**悄悄降低验收条件。
