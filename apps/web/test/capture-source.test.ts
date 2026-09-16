/**
 * 采集错误映射测试（roadmap A5 的一部分）。
 *
 * 目的：摄像头权限/可用性错误必须映射成**具体**的错误码与排查建议，
 * 而不是笼统的「摄像头失败」。这里锁住 `describeCameraError` 的七个分支，
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

  it("AbortError（设备在、但一直没画面）→ 给出可排查的原因，而不是英文原文", () => {
    // message 是实测原文：本机真实摄像头失败时 Chrome 抛的就是这一句
    const out = describeCameraError(err("AbortError", "Timeout starting video source"));
    expect(out.code).toBe("camera_unavailable");
    // 面向用户的文案不能直接把浏览器的英文原文端出去
    expect(out.message).not.toBe("Timeout starting video source");
    expect(out.message).toMatch(/超时|画面/);
    // 但排查方向必须是**具体**的，不能落到"改用导入视频"这种兜底话术
    expect(out.hint).toMatch(/隐私/);
    expect(out.hint).toMatch(/占用|USB|虚拟/);
    // 原始信息仍要保留，否则排查的人拿不到线索
    expect(out.detail).toContain("Timeout starting video source");
  });

  it("TimeoutError 与 AbortError 走同一分支", () => {
    const out = describeCameraError(err("TimeoutError", "starting video source timed out"));
    expect(out.code).toBe("camera_unavailable");
    expect(out.message).toMatch(/超时|画面/);
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
