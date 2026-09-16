# AGENTS.md

本文件是给 Coding Agent 的关键约束与文档入口。**不要在这里复制整份方案。**

## 文档入口

| 想知道 | 看 |
| --- | --- |
| 要做什么、当前阶段、已知限制 | `docs/spec.md` |
| 验收定义与阈值变更记录 | `docs/acceptance.md` |
| 坐标、单位、时钟、缺失值、schema 版本 | `docs/data-contracts.md` |
| 为什么这样选、何时替换 | `docs/decisions.md` |
| 实测结果（事实 / 推测 / 未验证） | `docs/evaluation-log.md` |
| 已知失败与修复 | `docs/known-failures.md` |
| 阈值与功能开关 | `configs/thresholds.json`（**规范快照，不被运行时读取**；实际标定值分两处，都在 `packages/motion-core`：规则阈值在 `src/rules.ts` 的 `DEFAULT_THRESHOLDS`、分段阈值在 `src/segmentation.ts` 的 `DEFAULT_SEGMENTATION`。快照与代码由测试**双向**守着一致） |
| 训练知识条目 | `knowledge/*.json` |
| 模型资产清单 | `models/manifest.json` |

## 依赖方向（不可违反）

- `packages/contracts` 不依赖任何应用。
- `packages/motion-core` **只**依赖 `contracts` 与纯计算工具。
  **不得**引入 DOM、React、MediaPipe、数据库或网络。新增依赖会破坏可测试性与离线评估能力。
- `apps/web` 依赖 `contracts + motion-core`。
- `apps/api` 依赖 `contracts`；**前端传来的数据必须再次校验**。

`contracts` 是数据契约的**唯一来源**。改字段先改契约，再改使用方。

## 硬性红线（改代码前必读）

1. **禁止用 0 填补缺失。** 一律 `null` + `reasonIfMissing`。0 是合法测量值。
2. **禁止把腕部速度峰值说成击球时刻。** 指标名为 `return_after_wrist_peak_ms`；
   未可靠识别触球前 `impactTimeMs` 恒为 `null`。
3. **禁止让单目二维骨架推断**：肌肉紧张、发力大小、足底承重、力量传递效率、精确拍面姿态。
   服务端有 `scanForbiddenClaims` 拦截，但拦截器**不等于**事实核查。
4. **规则未审核（`status !== "reviewed"` 或 `referenceId == null`）时，禁止输出达标/调整结论**，
   只能 `observation_only`。这条约束必须写在代码路径的**前面**。
5. **镜像预览不得改变人体真实左右标签。** 镜像只在绘制层处理。
6. **用归一化坐标算角度前必须乘回原图宽高。** 60° 会被算成 72°。
7. **不得用依赖未来整段数据的离线平滑。** 只用因果滤波。
8. **模型输出一律经 `validateModelOutput` 校验后才允许播报。** 伪造证据引用、旧会话响应、
   不允许的训练项一律拒绝，且**不能只靠提示词**。
9. **模型调用不阻塞摄像头与本地分析。** 模型失败时本地链路必须继续运行。
10. **mock 模式必须显著区分。** 绝不用 mock 结果填充真实延迟或准确率。
11. **API 密钥只在服务端。** 不放进前端环境变量或浏览器持久化存储。
12. **不自动重试模型超时**，避免重复费用与陈旧播报。

## 工程纪律

- 不做无差别调 prompt。同一问题先限定**两轮**有证据的修复，仍不通过就记录原因、换路径或收窄目标。
- **不要悄悄降低验收条件。** 改阈值必须记录理由与版本（`docs/acceptance.md`）。
- 不为静态文案和简单样式堆测试。合成样本适合验证计算和程序边界；
  **真实动作识别质量必须用真人标注数据验证**。
- 测试预期不能直接从被测算法的输出生成。
- 小批次提交：契约/采集 → 推理与叠加 → 分段/特征 → 证据/API → 反馈/复查 → 实测修复。
  每次提交说明：当前能运行什么、证据是什么、尚未验证什么。
- 真实视频与含个人信息的派生数据保存在 Git 之外。

## 常用命令

```bash
pnpm install          # 安装依赖
pnpm models:fetch     # 下载并校验模型资产
pnpm dev              # 启动前端（含 API 代理）
pnpm dev:api          # 单独启动后端
pnpm typecheck        # 类型检查全部包
pnpm test             # 运行全部测试
pnpm build            # 构建产物
```

## 当前阶段提醒

代码骨架已建立并通过自动化测试，但**真实摄像头、真实模型、真实动作全部未验证**。
任何性能与准确率数字都是拟定目标。新增文档或结论时，务必区分事实、推测与未验证项。
