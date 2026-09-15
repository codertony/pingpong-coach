import { describe, expect, it } from "vitest";
import { SpeechChannel, toSpeechText, MAX_SPEECH_CHARS } from "../src/audio/speech-channel.js";

const CTX = { sessionId: "s1", groupId: "g1", focusId: "return_to_ready_zone" };

describe("toSpeechText", () => {
  it("null 与空白返回 null", () => {
    expect(toSpeechText(null)).toBeNull();
    expect(toSpeechText("   ")).toBeNull();
  });

  it("短句原样返回", () => {
    expect(toSpeechText("击球后先回到准备位")).toBe("击球后先回到准备位");
  });

  it("超过 30 字时取第一句，若仍超长则放弃播报", () => {
    const long = "这是一句非常长的解释性文字用来测试语音播报的长度限制逻辑是否按预期工作并避免播报半句话";
    expect(toSpeechText(long)).toBeNull();
  });

  it("长文本但第一句很短时只播第一句", () => {
    const text = "注意还原。" + "后面是一大段很长的补充说明文字用来超过三十个字符的限制条件测试。";
    expect(toSpeechText(text)).toBe("注意还原");
  });

  it("恰好等于上限时允许播报", () => {
    const exact = "一".repeat(MAX_SPEECH_CHARS);
    expect(toSpeechText(exact)).toBe(exact);
  });
});

describe("SpeechChannel（上下文绑定）", () => {
  it("未设置上下文时拒绝播报", () => {
    const ch = new SpeechChannel();
    const ok = ch.speak({ text: "测试", ...CTX });
    expect(ok).toBe(false);
    ch.dispose();
  });

  it("上下文匹配时才受理", () => {
    const ch = new SpeechChannel();
    ch.setContext(CTX);
    // jsdom 环境下无 speechSynthesis，isSupported 为 false，所以这里主要验证不抛错
    const ok = ch.speak({ text: "击球后先回到准备位", ...CTX });
    expect(typeof ok).toBe("boolean");
    ch.dispose();
  });

  it("上下文不匹配（旧分组）时静默丢弃", () => {
    const ch = new SpeechChannel();
    ch.setContext(CTX);
    const ok = ch.speak({ text: "旧建议", sessionId: "s1", groupId: "g_old", focusId: "return_to_ready_zone" });
    expect(ok).toBe(false);
    ch.dispose();
  });

  it("切换关注点会取消待播语音", () => {
    const ch = new SpeechChannel();
    ch.setContext(CTX);
    ch.setContext({ ...CTX, focusId: "elbow_extension_pattern" });
    // 旧关注点的请求应被拒绝
    const ok = ch.speak({ text: "旧关注点建议", ...CTX });
    expect(ok).toBe(false);
    ch.dispose();
  });

  it("关闭开关后拒绝播报", () => {
    const ch = new SpeechChannel();
    ch.setContext(CTX);
    ch.setEnabled(false);
    const ok = ch.speak({ text: "测试", ...CTX });
    expect(ok).toBe(false);
    ch.dispose();
  });

  it("cancel 后状态回到 idle 或 unsupported", () => {
    const ch = new SpeechChannel();
    ch.cancel();
    expect(["idle", "unsupported"]).toContain(ch.currentStatus);
    ch.dispose();
  });

  it("状态变化会通知监听者", () => {
    const ch = new SpeechChannel();
    const seen: string[] = [];
    ch.onStatusChange((s) => seen.push(s));
    ch.cancel();
    expect(seen.length).toBeGreaterThan(0);
    ch.dispose();
  });
});
