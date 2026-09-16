/**
 * e2e 测试共用数据。
 */

/** 一组合法关键点：分布在一个合理的画面里，持拍侧（右）构成明显手臂折线。 */
export const KEYPOINTS = [
  { name: "nose", xPx: 320, yPx: 80, score: 0.95, visible: true },
  { name: "left_shoulder", xPx: 270, yPx: 140, score: 0.9, visible: true },
  { name: "right_shoulder", xPx: 370, yPx: 140, score: 0.9, visible: true },
  { name: "left_elbow", xPx: 240, yPx: 200, score: 0.88, visible: true },
  { name: "right_elbow", xPx: 430, yPx: 190, score: 0.88, visible: true },
  { name: "left_wrist", xPx: 220, yPx: 250, score: 0.85, visible: true },
  { name: "right_wrist", xPx: 500, yPx: 230, score: 0.85, visible: true },
  { name: "left_hip", xPx: 285, yPx: 250, score: 0.9, visible: true },
  { name: "right_hip", xPx: 355, yPx: 250, score: 0.9, visible: true },
  { name: "left_knee", xPx: 280, yPx: 320, score: 0.87, visible: true },
  { name: "right_knee", xPx: 360, yPx: 320, score: 0.87, visible: true },
  { name: "left_ankle", xPx: 275, yPx: 350, score: 0.8, visible: true },
  { name: "right_ankle", xPx: 365, yPx: 350, score: 0.8, visible: true },
];

/** 一个最小合法证据包，用于 API 客户端测试（图片为 1x1 占位，不含真实画面）。 */
export const TINY_PACKET = {
  schemaVersion: "1",
  requestId: "req-e2e-1",
  sessionId: "sess-e2e-1",
  groupId: "group-e2e-1",
  focusId: "return_to_ready_zone",
  strokeType: "forehand_drive",
  handedness: "right",
  cameraView: "front",
  perStrokeFeatures: [
    {
      strokeId: "st-1",
      features: [
        {
          id: "return_after_wrist_peak_ms",
          value: 260,
          unit: "ms",
          coordinateSpace: "image_2d",
          intervalMs: [520, 780],
          quality: "usable",
          reasonIfMissing: null,
        },
      ],
    },
  ],
  strokes: [
    {
      strokeId: "st-1",
      startMs: 0,
      endMs: 900,
      anchor: { type: "wrist_speed_peak", timeMs: 520 },
      impactTimeMs: null,
      complete: true,
      evidenceFrameIds: ["f-1"],
      reasons: [],
    },
  ],
  features: [
    {
      id: "return_after_wrist_peak_ms",
      value: 260,
      unit: "ms",
      coordinateSpace: "image_2d",
      intervalMs: [520, 780],
      quality: "usable",
      reasonIfMissing: null,
    },
  ],
  keyframes: [
    {
      id: "kf-1",
      sourceTimeMs: 520,
      jpegBase64:
        "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
      frameId: "f-1",
      width: 960,
      height: 540,
      role: "forward",
    },
  ],
  ruleVersion: "1.0.0",
  referenceId: null,
  criterion: {
    featureId: "return_after_wrist_peak_ms",
    threshold: 700,
    unit: "ms",
    minValidStrokes: 3,
  },
  limitations: ["仅正面机位"],
  readyZone: { xPx: 620, yPx: 300, radiusPx: 90 },
} as const;
