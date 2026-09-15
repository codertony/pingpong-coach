/**
 * 坐标变换。
 *
 * 铁律：镜像预览不得改变人体真实左右标签。
 * 因此本模块处理的是**几何坐标**的镜像，语义标签（left_/right_）的变换
 * 由 `mirrorHandedness` 单独、显式地完成，且只在"用户确实换了持拍手"时调用，
 * 不能因为开了镜像预览就调。
 */

import type { ImageTransform } from "@pingpong/contracts";
import type { Point2D } from "./geometry.js";

/**
 * 把画面坐标按 transform 映射回**原始未变换画面**的像素坐标。
 *
 * 顺序说明：采集端先裁剪、再旋转、最后可能做镜像预览。
 * 反解时按相反顺序还原。
 */
export function toSourcePixel(
  point: Point2D,
  transform: ImageTransform,
): Point2D | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  if (!(transform.cropWidth > 0) || !(transform.cropHeight > 0)) return null;

  // 1) 撤销镜像：镜像绕裁剪区中线翻转。
  let x = transform.mirrored ? transform.cropWidth - point.x : point.x;
  let y = point.y;

  // 2) 撤销裁剪：加回裁剪原点。
  x += transform.cropX;
  y += transform.cropY;

  // 3) 撤销旋转：绕裁剪区中心反向旋转。
  if (transform.rotationDeg !== 0) {
    const cx = transform.cropX + transform.cropWidth / 2;
    const cy = transform.cropY + transform.cropHeight / 2;
    const rad = (-transform.rotationDeg * Math.PI) / 180;
    const dx = x - cx;
    const dy = y - cy;
    x = cx + dx * Math.cos(rad) - dy * Math.sin(rad);
    y = cy + dx * Math.sin(rad) + dy * Math.cos(rad);
  }

  return { x, y };
}

/**
 * 把原始画面像素坐标变换到**当前显示/处理画面**坐标。
 * 与 toSourcePixel 互为逆运算。
 */
export function fromSourcePixel(
  point: Point2D,
  transform: ImageTransform,
): Point2D | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  if (!(transform.cropWidth > 0) || !(transform.cropHeight > 0)) return null;

  let x = point.x - transform.cropX;
  let y = point.y - transform.cropY;

  if (transform.rotationDeg !== 0) {
    const cx = transform.cropWidth / 2;
    const cy = transform.cropHeight / 2;
    const rad = (transform.rotationDeg * Math.PI) / 180;
    const dx = x - cx;
    const dy = y - cy;
    x = cx + dx * Math.cos(rad) - dy * Math.sin(rad);
    y = cy + dx * Math.sin(rad) + dy * Math.cos(rad);
  }

  if (transform.mirrored) {
    x = transform.cropWidth - x;
  }

  return { x, y };
}

/**
 * 判断某点是否在画面范围内，可指定边距（例如要求关节完整可见，
 * 贴边即视为不可靠）。
 */
export function isInsideFrame(
  point: Point2D,
  width: number,
  height: number,
  marginPx = 0,
): boolean {
  return (
    point.x >= marginPx &&
    point.y >= marginPx &&
    point.x <= width - marginPx &&
    point.y <= height - marginPx
  );
}

/**
 * 显式切换持拍手语义。
 *
 * 只应在**用户真实换了持拍手**时调用。
 * 开启镜像预览绝不能调用它 —— 镜像只改变画面显示，
 * 不改变"这个人是左手还是右手持拍"这个事实。
 */
export function mirrorHandedness(h: "left" | "right"): "left" | "right" {
  return h === "left" ? "right" : "left";
}
