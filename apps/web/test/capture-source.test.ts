/**
 * 采集错误映射测试（roadmap A5 的一部分）。
 *
 * 目的：摄像头权限/可用性错误必须映射成**具体**的错误码与排查建议，
 * 而不是笼统的「摄像头失败」。这里锁住 `describeCameraError` 的五种分支，
 * 防未来有人把它改回一句话通用文案。
 */

import { describe, expect, it } from "vitest";
import { describeCameraError } from "../src/capture/capture-source.js";

function err(name: string, message = ""): unknown {
  const e = new Error(message);
  e.name = name;
  return e;
}

describe("describeCameraError", () => {
  it("NotAllowedError → camera_permission_denied，提示 localhost/HTTPS", () => {
    const out = describeCameraError(err("NotAllowedError"));
    expect(out.code).toBe("camera_permission_denied");
    expect(out.hint).toMatch(/localhost|HTTPS/);
  });

  it("SecurityError 同样视为权限被拒", () => {
    const out = describeCameraError(err("SecurityError"));
    expect(out.code).toBe("camera_permission_denied");
  });

  it("NotFoundError / OverconstrainedError → camera_unavailable", () => {
    expect(describeCameraError(err("NotFoundError")).code).toBe("camera_unavailable");
    expect(describeCameraError(err("OverconstrainedError")).code).toBe("camera_unavailable");
  });

  it("NotReadableError → camera_unavailable，提示关闭占用摄像头的软件", () => {
    const out = describeCameraError(err("NotReadableError"));
    expect(out.code).toBe("camera_unavailable");
    expect(out.hint).toMatch(/占用|会议/);
  });

  it("未知错误 → camera_unavailable，并保留原始 message", () => {
    const out = describeCameraError(err("SomeUnknownError", "摄像头被拔出"));
    expect(out.code).toBe("camera_unavailable");
    expect(out.message).toBe("摄像头被拔出");
    expect(out.hint).toMatch(/导入视频/);
  });

  it("非 Error 输入（如字符串）也能兜底", () => {
    const out = describeCameraError("boom");
    expect(out.code).toBe("camera_unavailable");
    expect(out.message.length).toBeGreaterThan(0);
  });
});
