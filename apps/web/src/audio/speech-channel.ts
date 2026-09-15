/**
 * 语音播报调度。
 *
 * 约束（方案第 5 节）：
 * - 语音最多排队一条；暂停、结束或切换目标时取消旧语音。
 * - 反馈绑定 sessionId + groupId + focusId。切换后旧响应可以保存，
 *   但**不能**作为当前语音播报。
 * - 语音不可用时保留文本，并显示语音状态。
 */

export interface SpeechRequest {
  text: string;
  sessionId: string;
  groupId: string;
  focusId: string;
}

export type SpeechStatus = "unsupported" | "unavailable" | "idle" | "speaking";

export class SpeechChannel {
  private queue: SpeechRequest | null = null;
  private speaking = false;
  private enabled = true;
  private status: SpeechStatus = "idle";
  /** 当前允许播报的上下文 */
  private context: { sessionId: string; groupId: string; focusId: string } | null = null;
  private statusListeners = new Set<(s: SpeechStatus) => void>();

  constructor() {
    if (!this.isSupported()) {
      this.status = "unsupported";
    }
  }

  private isSupported(): boolean {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  get currentStatus(): SpeechStatus {
    return this.status;
  }

  onStatusChange(l: (s: SpeechStatus) => void): () => void {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }

  private setStatus(s: SpeechStatus): void {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  /** 由界面开关控制。关闭时立即取消当前播报。 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.cancel();
  }

  /**
   * 更新当前训练上下文（会话/分组/关注点）。
   * 上下文变化等于旧反馈失效，必须取消待播与在播语音。
   */
  setContext(ctx: { sessionId: string; groupId: string; focusId: string } | null): void {
    const changed =
      this.context == null ||
      ctx == null ||
      this.context.sessionId !== ctx.sessionId ||
      this.context.groupId !== ctx.groupId ||
      this.context.focusId !== ctx.focusId;
    this.context = ctx;
    if (changed) this.cancel();
  }

  /**
   * 请求播报。绑定上下文不匹配的请求会被直接丢弃 —— 旧会话的建议
   * 绝不能播到当前这一组。
   */
  speak(req: SpeechRequest): boolean {
    if (!this.enabled) return false;
    if (!this.isSupported()) {
      this.setStatus("unsupported");
      return false;
    }
    if (this.context == null) return false;
    if (
      req.sessionId !== this.context.sessionId ||
      req.groupId !== this.context.groupId ||
      req.focusId !== this.context.focusId
    ) {
      // 陈旧上下文，静默丢弃（上层仍可把它保存进历史）
      return false;
    }

    // 最多排队一条：新的请求替换旧的
    this.queue = req;
    this.pump();
    return true;
  }

  private pump(): void {
    if (this.speaking) return;
    const next = this.queue;
    if (!next) {
      this.setStatus("idle");
      return;
    }
    this.queue = null;

    try {
      const utter = new SpeechSynthesisUtterance(next.text);
      utter.lang = "zh-CN";
      utter.onstart = () => this.setStatus("speaking");
      utter.onend = () => {
        this.speaking = false;
        this.setStatus("idle");
        this.pump();
      };
      utter.onerror = () => {
        this.speaking = false;
        // 语音不可用时保留文本，只更新状态
        this.setStatus("unavailable");
        this.pump();
      };
      this.speaking = true;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utter);
    } catch {
      this.speaking = false;
      this.setStatus("unavailable");
    }
  }

  /** 取消待播与在播语音。暂停、结束、切换目标时调用。 */
  cancel(): void {
    this.queue = null;
    if (this.isSupported()) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* 忽略：语音系统不可用不影响训练 */
      }
    }
    this.speaking = false;
    this.setStatus(this.isSupported() ? "idle" : "unsupported");
  }

  dispose(): void {
    this.cancel();
    this.statusListeners.clear();
    this.context = null;
  }
}

/** 把长解释压缩为可播报的短句。长解释只在复查页显示。 */
export const MAX_SPEECH_CHARS = 30;

export function toSpeechText(cue: string | null): string | null {
  if (cue == null) return null;
  const trimmed = cue.trim();
  if (trimmed === "") return null;
  if ([...trimmed].length > MAX_SPEECH_CHARS) {
    // 超长不截断成半句话，宁可只播前一句
    const firstSentence = trimmed.split(/[。！？!?]/)[0]?.trim();
    if (firstSentence && [...firstSentence].length <= MAX_SPEECH_CHARS) return firstSentence;
    return null;
  }
  return trimmed;
}
