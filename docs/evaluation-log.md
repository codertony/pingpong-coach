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
