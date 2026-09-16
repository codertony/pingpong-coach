/**
 * 摄像头枚举与逐设备取流的探针（F-009）。
 *
 * 为什么自己要起浏览器：项目级 `launchOptions` 里带着
 * `--use-fake-device-for-media-stream`（让采集链路在无摄像头的 CI 上也能确定性跑通），
 * 那个开关会**把真实摄像头换成假设备** —— 在它下面无论怎么测都得不到
 * "用户机器上能不能用摄像头"这个答案。这里绕开项目配置自己启动，并且
 * **只**保留 `--use-fake-ui-for-media-stream`（自动接受权限弹窗，不换设备）。
 *
 * 三个阶段，故意分开，因为答案完全不同：
 *   A. **不给权限**枚举 —— deviceId 是不是空串。这决定"让用户先选设备、
 *      再申请权限"这条修法可不可行。
 *   B. **产品现在的调用方式**（`getUserMedia({video: true})`，默认设备）——
 *      能不能起来。
 *   C. 显式授权后，**逐个设备**精确试开 —— 到底哪个摄像头能用。
 *
 * ⚠️ 阶段 A 有个**已知的口径缺陷**：`--use-fake-ui-for-media-stream` 可能会
 * 让 Chrome 一开始就认为权限已授予，于是 A 测到的其实是"已授权"的状态。
 * 实测本机 A 返回 5 个设备、deviceId 与 label 都非空 —— 这**不能**据此断言
 * 普通 Chrome 未授权时也拿得到 deviceId。要下这个结论，得另起一个不带该开关的
 * 浏览器来测（本项目暂未做，因为 A 的结论不影响任何现有实现）。
 *
 * ⚠️ 需要真实摄像头，且会短暂弹出浏览器窗口。未设置 `PPC_PROBE_CAMERA=1` 时 skip。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, test, expect } from "@playwright/test";

const ENABLED = process.env.PPC_PROBE_CAMERA === "1";

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../.tmp-overlay");

/**
 * 每台设备的试开超时。起不来的设备不能把整个探针挂住。
 *
 * 可调是因为**要用来做对照**：第一版固定 8 秒，真实摄像头报超时，
 * 我一度以为是自己设得太短（USB 冷启动慢）。调到 30 秒复测，它仍在
 * **10.0 秒**处失败 —— 那是 **Chrome 自己的设备启动超时**，与这里设多少无关。
 * 所以"只是慢"这个解释是被这个开关**排除**掉的，不是被它证实。
 */
const PER_DEVICE_TIMEOUT_MS = Number(process.env.PPC_CAMERA_TIMEOUT_MS ?? 8_000);

/** 真实浏览器可执行文件。与 playwright.config.ts 同一套探测顺序。 */
function resolveChrome(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  return candidates.find((p) => existsSync(p));
}

test.describe("摄像头枚举与逐设备取流", () => {
  test.skip(!ENABLED, "未设置 PPC_PROBE_CAMERA=1（需要真实摄像头），跳过");

  test("枚举、默认设备取流、逐设备取流", async () => {
    test.setTimeout(300_000);

    const executablePath = resolveChrome();
    const browser = await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      args: ["--use-fake-ui-for-media-stream"],
    });

    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto("/e2e/fixtures/fixture.html");
      await page.waitForFunction(() => Boolean(window.__fixture));

      // origin 从**实际打开的页面**取，而不是把端口写死 —— 端口可由 E2E_PORT 覆盖。
      const origin = new URL(page.url()).origin;

      // ── 阶段 A + B：不给权限枚举；再按产品现在的写法取一次流 ──
      const phase1 = await page.evaluate(async (timeoutMs: number) => {
        const noPerm = (await navigator.mediaDevices.enumerateDevices()).filter(
          (d) => d.kind === "videoinput",
        );

        let defaultError: string | null = null;
        let defaultSize = "";
        const t0 = Date.now();
        try {
          const s = await Promise.race([
            navigator.mediaDevices.getUserMedia({ video: true, audio: false }),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
          ]);
          const track = s.getVideoTracks()[0];
          const st = track?.getSettings() ?? {};
          defaultSize = `${st.width ?? "?"}×${st.height ?? "?"}`;
          s.getTracks().forEach((t) => t.stop());
        } catch (e) {
          defaultError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        }

        return {
          secureContext: window.isSecureContext,
          noPermCount: noPerm.length,
          noPermAllDeviceIdsEmpty: noPerm.every((d) => d.deviceId === ""),
          noPermAllLabelsEmpty: noPerm.every((d) => d.label === ""),
          defaultCall: { error: defaultError, size: defaultSize, ms: Date.now() - t0 },
        };
      }, PER_DEVICE_TIMEOUT_MS);

      // ── 阶段 C：显式授权（等价于"用户点了允许"），再枚举 + 逐设备试开 ──
      let granted = false;
      try {
        await context.grantPermissions(["camera"], { origin });
        granted = true;
      } catch {
        // 授权 API 失败时靠 --use-fake-ui 兜底，如实记录
      }

      const phase3 = await page.evaluate(async (timeoutMs: number) => {
        const tryDevice = async (id: string) => {
          const started = Date.now();
          let stream: MediaStream | null = null;
          try {
            stream = await Promise.race([
              navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: id } },
                audio: false,
              }),
              new Promise<never>((_, rej) =>
                setTimeout(() => rej(new Error("timeout")), timeoutMs),
              ),
            ]);
          } catch (e) {
            return {
              ok: false as const,
              error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
              ms: Date.now() - started,
            };
          }
          const track = stream.getVideoTracks()[0];
          const settings = (track?.getSettings() ?? {}) as Record<string, unknown>;
          const el = document.createElement("video");
          el.srcObject = stream;
          el.muted = true;
          await el.play().catch(() => {});
          await new Promise<void>((r) => {
            const t = setTimeout(r, 2000);
            el.onloadedmetadata = () => {
              clearTimeout(t);
              r();
            };
          });
          const width = el.videoWidth;
          const height = el.videoHeight;
          stream.getTracks().forEach((t) => t.stop());
          return { ok: true as const, width, height, settings, ms: Date.now() - started };
        };

        const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
          (d) => d.kind === "videoinput",
        );
        const perDevice: Array<Record<string, unknown>> = [];
        for (const d of devices) {
          const r = await tryDevice(d.deviceId);
          perDevice.push({
            label: d.label || "(无 label)",
            deviceIdPrefix: d.deviceId.slice(0, 8),
            ...r,
          });
        }
        return { count: devices.length, perDevice };
      }, PER_DEVICE_TIMEOUT_MS);

      const report = { origin, granted, phase1, phase3 };
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(resolve(OUT_DIR, "camera-probe.json"), JSON.stringify(report, null, 2), "utf8");

      const { defaultCall, noPermCount, noPermAllDeviceIdsEmpty, noPermAllLabelsEmpty } = phase1;
      const okDevices = phase3.perDevice.filter((d) => d.ok);

      console.warn(
        [
          "",
          `安全上下文 = ${phase1.secureContext}；显式授权 = ${granted}`,
          `A. **未授权**时枚举到 ${noPermCount} 个 videoinput；` +
            `deviceId 全为空=${noPermAllDeviceIdsEmpty}，label 全为空=${noPermAllLabelsEmpty}`,
          `B. **产品现在的调用方式**（默认设备）：` +
            (defaultCall.error
              ? `失败 "${defaultCall.error}"（${defaultCall.ms}ms）`
              : `成功 ${defaultCall.size}（${defaultCall.ms}ms）`),
          `C. 授权后枚举到 ${phase3.count} 个设备，逐个精确试开：`,
          ...phase3.perDevice.map(
            (d) =>
              `   ${d.ok ? "✅" : "❌"} ${d.label}` +
              (d.ok ? `  ${d.width}×${d.height}（${d.ms}ms）` : `  ${d.error}（${d.ms}ms）`),
          ),
          "",
        ].join("\n"),
      );

      expect(phase1.secureContext, "不是安全上下文，getUserMedia 必然失败").toBe(true);
      expect(phase3.count, "枚举不到任何 videoinput —— 浏览器看不到摄像头设备").toBeGreaterThan(0);
      expect(
        okDevices.length,
        `枚举到 ${phase3.count} 个设备，但**没有一个**能真正取到流：` +
          phase3.perDevice.map((d) => `${d.label}=${d.error}`).join("; "),
      ).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  });
});
