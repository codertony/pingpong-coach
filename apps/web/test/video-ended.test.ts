// @vitest-environment jsdom
/**
 * 导入视频的**结束语义**（用户报的 bug）。
 *
 * 用户原话先是这样："在练习的视频页面中，导入视频……视频已经停止的情况下，
 * 框架还在移动"；修完 F-040 之后又变成："视频导入后一直在轮询播放，
 * 反复播放且不会停止"。**两次现象不同，根因是同一行** `video.loop = true`：
 * F-040 之前界面上的 `<video>` 是另一个播放实例（`loop` 默认 false），
 * 所以看到的是"画面停了、骨架还在动"；F-040 把两个实例并成一个之后，
 * 循环就直接显形了。
 *
 * 这个文件钉住四件事：
 * 1. 素材**不循环**（`loop` 必须是 false）；
 * 2. 播完会**上报一次** `ended`（上层据此收尾并交出本组证据）；
 * 3. 播完之后**不再有帧**进分析；
 * 4. 停止时**保留最后一帧**（F-040 让采集元素就是显示元素，
 *    抹掉 `src` 就等于把用户眼前的画面变黑，而这一刻分析请求可能刚发出去）。
 *
 * jsdom 没有媒体栈，所以这里把 `<video>` 的必要行为显式打桩 ——
 * 打的是"这个元素能不能播、能不能给尺寸、有没有 src"，不是被测逻辑本身。
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startCapture } from "../src/capture/capture-source.js";

/* ── jsdom 没有的媒体能力：显式打桩 ── */

const proto = HTMLVideoElement.prototype;

/**
 * 打桩前先记下原样。
 *
 * jsdom 里 `videoWidth`/`videoHeight`/`src` 走的是属性反射，直接赋值会尝试
 * 加载资源；`srcObject` 可能压根不存在。所以这几个一律改成**普通属性**，
 * 用完在 `afterAll` 里还原（或者说，删掉我们加的）。
 */
const stubbed = ["videoWidth", "videoHeight", "src", "srcObject"] as const;
const hadOwn = new Map<string, PropertyDescriptor | undefined>();
const originals = {
  play: proto.play,
  pause: proto.pause,
  addEventListener: proto.addEventListener,
  rvfc: (proto as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback,
  cancelRvfc: (proto as { cancelVideoFrameCallback?: unknown }).cancelVideoFrameCallback,
};

/** 捕获由 startCapture 内部创建的那个 `<video>`，并把 `loadedmetadata` 补上。 */
let created: HTMLVideoElement | null = null;
/** 被注册进来的逐帧回调；测试手动调用它来"喂一帧"。 */
let frameCallback: ((now: number, meta: { mediaTime: number }) => void) | null = null;

function installVideoStubs(): void {
  const define = (key: string, get: () => unknown, set?: (v: unknown) => void): void => {
    if (!hadOwn.has(key)) hadOwn.set(key, Object.getOwnPropertyDescriptor(proto, key));
    Object.defineProperty(proto, key, { configurable: true, get, set });
  };
  define("videoWidth", () => 1280);
  define("videoHeight", () => 720);
  define(
    "src",
    function (this: HTMLVideoElement) {
      return (this as HTMLVideoElement & { __src?: string }).__src ?? "";
    },
    function (this: HTMLVideoElement, v: unknown) {
      (this as HTMLVideoElement & { __src?: string }).__src = String(v);
    },
  );
  define(
    "srcObject",
    function (this: HTMLVideoElement) {
      return (this as HTMLVideoElement & { __srcObject?: MediaStream | null }).__srcObject ?? null;
    },
    function (this: HTMLVideoElement, v: unknown) {
      (this as HTMLVideoElement & { __srcObject?: MediaStream | null }).__srcObject =
        v as MediaStream | null;
    },
  );

  proto.play = () => Promise.resolve();
  proto.pause = () => {};
  /*
   * `loadedmetadata` 在 jsdom 里永远不来，得自己补。
   *
   * **必须挂在 `addEventListener` 上**，不能用 `queueMicrotask` 提前排队：
   * startCapture 里 `await new Promise(loadedmetadata)` 之前，
   * 摄像头那条路还要先 `await getUserMedia(...)` —— 提前排的微任务
   * 会在那个 await 期间就烧掉，事件在监听器注册**之前**派发，于是永远等下去。
   * 挂在注册动作上就不可能抢跑。
   */
  proto.addEventListener = function (
    this: HTMLVideoElement,
    type: string,
    listener: EventListenerOrEventListenerObject,
    opts?: boolean | AddEventListenerOptions,
  ) {
    originals.addEventListener.call(this, type, listener, opts);
    if (type === "loadedmetadata") {
      queueMicrotask(() => {
        this.dispatchEvent(new Event("loadedmetadata"));
      });
    }
  } as typeof proto.addEventListener;
  (proto as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback = (
    cb: (now: number, meta: { mediaTime: number }) => void,
  ) => {
    frameCallback = cb;
    return 1;
  };
  (proto as { cancelVideoFrameCallback?: unknown }).cancelVideoFrameCallback = () => {};
}

afterAll(() => {
  for (const key of stubbed) {
    const original = hadOwn.get(key);
    if (original) Object.defineProperty(proto, key, original);
    else delete (proto as unknown as Record<string, unknown>)[key];
  }
  proto.play = originals.play;
  proto.pause = originals.pause;
  // addEventListener 继承自 EventTarget，我们只是临时盖了一层 —— 删掉就还原
  delete (proto as unknown as Record<string, unknown>).addEventListener;
  if (originals.rvfc)
    (proto as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback = originals.rvfc;
  else delete (proto as unknown as Record<string, unknown>).requestVideoFrameCallback;
  if (originals.cancelRvfc)
    (proto as { cancelVideoFrameCallback?: unknown }).cancelVideoFrameCallback =
      originals.cancelRvfc;
  else delete (proto as unknown as Record<string, unknown>).cancelVideoFrameCallback;
});

beforeEach(() => {
  created = null;
  frameCallback = null;
  installVideoStubs();

  // 捕获内部创建的 video 元素（startCapture 自己 new 一个，不给我们看）
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    const node = realCreate(tag) as HTMLElement;
    if (tag === "video") created = node as HTMLVideoElement;
    return node;
  }) as typeof document.createElement);

  // blob URL 与位图：jsdom 都没有
  vi.stubGlobal("createImageBitmap", () =>
    Promise.resolve({ width: 1280, height: 720, close: () => {} }),
  );
  const fakeUrl = "blob:http://localhost/fake-uuid";
  Object.assign(URL, { createObjectURL: () => fakeUrl, revokeObjectURL: () => {} });
});

/** 喂一帧并等两次微任务（`emit` 里 `createImageBitmap` 是异步的）。 */
async function feedFrame(mediaTimeSec: number): Promise<void> {
  frameCallback?.(0, { mediaTime: mediaTimeSec });
  await Promise.resolve();
  await Promise.resolve();
}

async function startVideoCapture(onEnded?: () => void): Promise<{
  frames: number[];
  handle: Awaited<ReturnType<typeof startCapture>>;
}> {
  const frames: number[] = [];
  const handle = await startCapture({
    kind: "video",
    getEpoch: () => 0,
    onFrame: (f) => frames.push(f.sourceTimeMs),
    videoFile: new File([new Uint8Array([1, 2, 3])], "clip.mp4", { type: "video/mp4" }),
    onEnded,
  });
  return { frames, handle };
}

describe("导入视频的结束语义", () => {
  it("**不许循环** —— 这就是用户报的「反复播放且不会停止」", async () => {
    const { handle } = await startVideoCapture();
    expect(created, "没拿到内部创建的 video 元素，夹具失效").not.toBeNull();
    expect(created!.loop, "loop 为 true 时素材永远播不完，用户没有任何办法让它停").toBe(false);
    handle.stop();
  });

  it("播完上报一次 `ended`，且**只上报一次**", async () => {
    const ended = vi.fn();
    const { handle } = await startVideoCapture(ended);

    created!.dispatchEvent(new Event("ended"));
    // 重复派发不该被当成"又结束了一次"——上层会因此重复交出证据
    created!.dispatchEvent(new Event("ended"));

    expect(ended).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it("播完之后**不再有帧**进分析（骨架不会继续动）", async () => {
    const { frames, handle } = await startVideoCapture();

    await feedFrame(1.0);
    expect(frames, "正常播放时应当有帧").toEqual([1000]);

    created!.dispatchEvent(new Event("ended"));
    await feedFrame(2.0);

    expect(frames, "素材已经播完，还有帧被送去分析 —— 画面与分析又对不上了").toEqual([1000]);
    handle.stop();
  });

  it("停止时**保留最后一帧**：采集元素就是显示元素，抹掉 src 等于把画面变黑", async () => {
    const { handle } = await startVideoCapture();
    await feedFrame(1.0);
    const srcBefore = created!.src;

    handle.stop();

    expect(srcBefore, "采集时 video 上就该有 src").toBeTruthy();
    expect(
      created!.src,
      "停止时把 src 摘了 —— 用户眼前的最后一帧会变成黑屏，而分析请求可能刚开始",
    ).toBe(srcBefore);
  });

  it("**摄像头那条路仍然清空 srcObject**（上面那条「保留」只适用于导入视频）", async () => {
    // 反向对照必须**真的跑另一条分支**：`stop()` 里为了保留画面给 video
    // 加了提前返回，这个返回一旦写宽了，摄像头停止后就会留着一条没用的轨道引用。
    const track = {
      getSettings: () => ({ frameRate: 30 }),
      addEventListener: () => {},
      removeEventListener: () => {},
      readyState: "live" as MediaStreamTrackState,
      stop: () => {},
    };
    const stream = {
      getVideoTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => Promise.resolve(stream) },
    });

    const handle = await startCapture({ kind: "camera", getEpoch: () => 0, onFrame: () => {} });
    expect(created!.srcObject, "摄像头采集期间本该挂着这条流").toBe(stream);

    handle.stop();

    expect(created!.srcObject, "摄像头停止后还留着轨道引用").toBeNull();
  });
});
