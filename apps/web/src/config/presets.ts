/**
 * 界面预设。与 knowledge/ 与 configs/ 保持一致。
 * 这里只放展示用的标签，实际判定阈值来自 motion-core 的规则定义。
 */

export interface SelectOption {
  id: string;
  label: string;
}

export const STROKE_TYPE_OPTIONS: SelectOption[] = [
  { id: "forehand_drive", label: "定点正手攻球" },
];

export const FOCUS_OPTIONS: SelectOption[] = [
  { id: "return_to_ready_zone", label: "回到本组准备区域" },
  { id: "elbow_extension_pattern", label: "肘角伸展模式（仅观察）" },
  { id: "elbow_relative_torso_drift", label: "肘相对躯干移动（仅观察）" },
];

export const CAMERA_VIEW_OPTIONS: SelectOption[] = [
  { id: "front", label: "正面" },
  { id: "front_right_diagonal", label: "右前斜" },
  { id: "front_left_diagonal", label: "左前斜" },
  { id: "right_side", label: "右侧" },
  { id: "unknown", label: "不确定" },
];
