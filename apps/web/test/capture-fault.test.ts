// @vitest-environment jsdom
import "./setup";

/**
 * 摄像头**中途断开**的上报路径（F-014）。
 *
 * ## 为什么单独测这个
 *
 * F-014 报的是：摄像头拔掉之后，轨道 `readyState` 变成 `ended`、画面停在最后一帧，
 * 而界面**照样显示"采集中"**、状态栏照样说"等待有效挥拍" —— 用户会一直干等一个
 * 不会再来的画面。当时的修复是两条通路都上报：轨道的 `ended`/`mute` 事件，
 * 以及一个 500ms 的存活探测（有些平台不发 ended）。
 *
 * 但修完之后**这条路径没有任何回归** —— 而它恰恰是最难在开发时碰到的一条
 * （要有摄像头、还要在跑的时候拔掉）。所以这里用假 track 把它锁住：
 * **两条通路各自能报、且只报一次、停完之后不再报**。
 *
 * 故意不做的事：不去断言 App 界面怎么显示（那是组件测试的事），
 * 这里只钉住"采集层有没有把这件事说出来"。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { startCapture, type CaptureOptions } from "../src/capture/capture-source.js";

/**
 * 假轨道：能记下监听器、能改 `readyState`（模拟被拔掉）。
 *
 * `readyState` 用**私有可变对象 + getter** 暴露：真实类型上它是只读的，
 * 直接赋值连类型检查都过不去（而我们在测试里就是要改它 —— 模拟拔设备）。
 * `setEnded()` 是唯一改动它的入口，两条通路（事件 / 存活探测）共用同一个状态。
 */
function makeTrack(): {
  track: MediaStreamTrack;
  fire: (type: string) => void;
  setEnded: () => void;
  listeners: Map<string, Set<() => void>>;
} {
  const listeners = new Map<string, Set<() => void>>();
  const state = { readyState: "live" as MediaStreamTrackState };
  const track = {
    get readyState() {
      return state.readyState;
    },
    getSettings: () => ({ frameRate: 30, width: 1280, height: 720 }),
    addEventListener: (type: string, fn: () => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn);
    },
    stop: () => {
      state.readyState = "ended";
    },
  } as unknown as MediaStreamTrack;
  return {
    track,
    listeners,
    setEnded: () => {
      state.readyState = "ended";
    },
    fire: (type: string) => {
      for (const fn of listeners.get(type) ?? []) fn();
    },
  };
}

function stubCamera(track: MediaStreamTrack): void {
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => stream },
  });
}

/**
 * 跑一次 `startCapture` 并把它推进到"监听器已挂上"。
 *
 * 为什么需要这个：`startCapture` 会等 `loadedmetadata`（两条来源都等），
 * 而 **jsdom 不会给 `srcObject` 派发这个事件** —— 直接 await 会永远挂住，
 * 表现出来是四个用例集体超时。所以这里自己把那个事件派出去。
 *
 * 顺带记一条**没有证据的观察**（不要当成缺陷）：那个 await **没有超时**，
 * 所以万一某个平台真的不派 `loadedmetadata`，采集会永远停在启动中、
 * 而界面不会报错。我没能复现这种情况（真实浏览器两条来源都会派），
 * 所以**没有**去加超时 —— 不为一个没能复现的场景加代码。
 */
async function startAndSettle(onFault: CaptureOptions["onFault"]) {
  const created: HTMLVideoElement[] = [];
  const realCreate = document.createElement.bind(document);
  const spy = vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = realCreate(tag);
    if (tag === "video") created.push(el as HTMLVideoElement);
    return el;
  });
  const pending = startCapture(options(onFault));
  // 等到元素建出来、监听器挂上，再把 loadedmetadata 派给它
  await vi.waitFor(() => expect(created.length).toBeGreaterThan(0));
  created[0]!.dispatchEvent(new Event("loadedmetadata"));
  const handle = await pending;
  spy.mockRestore();
  return { handle, created };
}

function options(onFault: CaptureOptions["onFault"]): CaptureOptions {
  return {
    kind: "camera",
    getEpoch: () => 0,
    onFrame: () => {},
    onFault,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("摄像头断开上报（F-014）", () => {
  it("轨道发 `ended` 时上报一次，文案是中文且给出可执行的排查方向", async () => {
    const { track, fire } = makeTrack();
    stubCamera(track);
    const faults: Array<{ code: string; message: string; hint: string }> = [];

    const { handle } = await startAndSettle((f) => faults.push(f));
    fire("ended");

    expect(faults, "轨道结束了却没上报 —— 界面会继续显示「采集中」").toHaveLength(1);
    expect(faults[0]!.code).toBe("camera_disconnected");
    // 面向用户的文案不能是浏览器原文（`readyState` 变 ended 本身没有 message）
    expect(faults[0]!.message).toMatch(/断开/);
    expect(faults[0]!.hint).toMatch(/拔掉|占用/);
    handle.stop();
  });

  it("`ended` 与 `mute` 都发也**只报一次**（否则界面会被同一次断开刷屏）", async () => {
    const { track, fire } = makeTrack();
    stubCamera(track);
    const faults: unknown[] = [];

    const { handle } = await startAndSettle((f) => faults.push(f));
    fire("ended");
    fire("mute");

    expect(faults).toHaveLength(1);
    handle.stop();
  });

  it("**不发事件、只把 readyState 改成 ended** 的平台由 500ms 存活探测兜住", async () => {
    // 这条是"两条通路"里容易被忽略的那条：有些平台拔掉设备**不发 ended**，
    // 只把 readyState 改掉。只靠事件监听的话，那种平台会永远静默。
    vi.useFakeTimers();
    const { track, setEnded } = makeTrack();
    stubCamera(track);
    const faults: unknown[] = [];

    const { handle } = await startAndSettle((f) => faults.push(f));
    expect(faults, "还没断开就报了？").toHaveLength(0);

    setEnded();
    await vi.advanceTimersByTimeAsync(600);

    expect(faults, "readyState 变 ended 之后存活探测没有上报").toHaveLength(1);
    handle.stop();
  });

  it("`stop()` 之后不再上报 —— 停止本身也会让轨道 ended，不能把自己的停止报成故障", async () => {
    const { track, fire, listeners } = makeTrack();
    stubCamera(track);
    const faults: unknown[] = [];

    const { handle } = await startAndSettle((f) => faults.push(f));
    handle.stop();
    // 监听器应当已被摘掉；即便还在，`running` 也已为 false
    expect(listeners.get("ended")?.size ?? 0).toBe(0);
    fire("ended");

    expect(faults, "停止之后把自己的收尾报成了「摄像头已断开」").toHaveLength(0);
  });
});
