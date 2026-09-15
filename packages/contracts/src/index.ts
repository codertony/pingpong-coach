/**
 * @pingpong/contracts
 *
 * 全链路数据契约的**唯一来源**。
 * web 与 api 都必须从这里取类型和校验器；api 接收前端数据时必须再次校验。
 *
 * 数据链：PoseFrame → StrokeEvent → FeatureSet → EvidencePacket → CoachFeedback
 */

export * from "./constants.js";
export * from "./primitives.js";
export * from "./pose-frame.js";
export * from "./stroke.js";
export * from "./feature.js";
export * from "./evidence.js";
export * from "./api.js";
