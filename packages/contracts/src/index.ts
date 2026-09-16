/**
 * @pingpong/contracts
 *
 * 全链路数据契约的**唯一来源**。
 * web 与 api 都必须从这里取类型和校验器；api 接收前端数据时必须再次校验。
 *
 * 数据链：PoseFrame → StrokeEvent → **FeatureSet** → EvidencePacket → CoachFeedback
 *                          ^^^^^^^^^^^ **这一环目前是空的**：没有任何产品代码
 *                          构造或读取 `FeatureSet`（只在 定义 + 本注释 + 一致性测试里出现），
 *                          产品链路直接从 StrokeEvent 走到 EvidencePacket（特征是包内数组）。
 *                          留着它的形状是给 P1 的"逐阶段指标"用；**不要**把它当成已接线的一环。
 */

export * from "./constants.js";
export * from "./primitives.js";
export * from "./pose-frame.js";
export * from "./stroke.js";
export * from "./feature.js";
export * from "./evidence.js";
export * from "./api.js";
