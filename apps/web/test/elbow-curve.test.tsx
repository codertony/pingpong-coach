// @vitest-environment jsdom
import "./setup";

/**
 * 肘角曲线的画法（复查页）。
 *
 * 这个组件最容易做错的地方**不是画得像不像，而是缺测怎么处理**：
 * 缺测一旦被插值或被 0 填平，曲线看起来"很完整"，而它恰好掩盖了最该被看见的东西
 * （遮挡、身体出画）。所以下面大多数用例都在钉"断口"。
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ElbowCurve } from "../src/ui/ElbowCurve.js";
import type { ElbowTrace } from "../src/training/training-session.js";

/** 造一条 trace：`samples` 是 [tMs, 角度或 null]。 */
function trace(
  samples: Array<[number, number | null]>,
  overrides: Partial<ElbowTrace> = {},
): ElbowTrace {
  return {
    intervalMs: [0, 1000],
    samples: samples.map(([tMs, elbowAngleDeg]) => ({ tMs, elbowAngleDeg })),
    events: [],
    strokeSpans: [],
    ...overrides,
  };
}

/** 每 40ms 一帧的常规采样 */
const every40 = (angles: Array<number | null>): Array<[number, number | null]> =>
  angles.map((a, i) => [i * 40, a]);

const segments = (): Element[] => [...document.querySelectorAll(".elbow-segment")];

describe("ElbowCurve", () => {
  it("连成一条线（没有缺失时只有一段）", () => {
    render(<ElbowCurve trace={trace(every40([150, 160, 140, 130, 120]))} />);
    expect(segments()).toHaveLength(1);
    expect(segments()[0]!.tagName.toLowerCase()).toBe("polyline");
  });

  it("**缺测画成断口**：中间那一帧没有值，线就断开，不连过去", () => {
    // 中间第 3 帧测不到 → 应当得到两段，而不是一条把断口连起来的线
    render(<ElbowCurve trace={trace(every40([150, 160, null, 130, 120]))} />);
    expect(segments()).toHaveLength(2);
    for (const seg of segments()) {
      expect(seg.tagName.toLowerCase()).toBe("polyline");
    }
  });

  it("**帧根本没检出人**（样本里没有这一帧）也断开 —— 靠时间间隔判", () => {
    // 正常每 40ms 一帧，中间空了 400ms（连续 10 帧没有姿态）
    const gapped: Array<[number, number | null]> = [
      [0, 150],
      [40, 155],
      [80, 158],
      [480, 120], // 断口：距上一帧 400ms，远超 40ms 的中位间隔
      [520, 118],
    ];
    render(<ElbowCurve trace={trace(gapped)} />);
    expect(
      segments(),
      "时间上断了一大段却连成一条直线 —— 看起来像「这一段一直是这样」，其实是没测到",
    ).toHaveLength(2);
  });

  it("**全是缺失**时不画线，明说画不出来", () => {
    render(<ElbowCurve trace={trace(every40([null, null, null]))} />);
    expect(segments()).toHaveLength(0);
    expect(screen.getByText(/画不出曲线/)).toBeInTheDocument();
    // 红线 1：不许用 0 或者平均值把断口填上
    expect(screen.getByText(/不插值/)).toBeInTheDocument();
  });

  it("只有 1 帧有值时也画不出（一条线至少要两个点）", () => {
    render(<ElbowCurve trace={trace(every40([null, 150, null]))} />);
    expect(segments()).toHaveLength(0);
    expect(screen.getByText(/只有 1 帧测到肘角/)).toBeInTheDocument();
  });

  it("**孤立的一个点不丢**：画成点而不是当成噪声删掉", () => {
    // 第一帧单独有值，接着一整段缺失，最后一段连续
    const isolated: Array<[number, number | null]> = [
      [0, 150],
      [40, null],
      [80, null],
      [120, 140],
      [160, 138],
      [200, 136],
    ];
    render(<ElbowCurve trace={trace(isolated)} />);
    const kinds = segments().map((s) => s.tagName.toLowerCase());
    expect(kinds, `画出来的是 ${JSON.stringify(kinds)}`).toContain("circle");
    expect(kinds).toContain("polyline");
  });

  it("阶段转变画成竖线，且文案说明**不是击球时刻**", () => {
    render(
      <ElbowCurve
        trace={trace(every40([150, 160, 140, 130]), {
          events: [
            { strokeId: "st-1", eventType: "backswing_start", timeMs: 40 },
            { strokeId: "st-1", eventType: "forward_start", timeMs: 80 },
          ],
        })}
      />,
    );
    const dashed = [...document.querySelectorAll("line")].filter(
      (l) => l.getAttribute("stroke-dasharray") != null,
    );
    expect(dashed, "两个事件应当有两条竖虚线").toHaveLength(2);
    // 红线 2：这些竖线是状态机的转变，不能让人读成击球
    expect(screen.getByText(/阶段转变/)).toBeInTheDocument();
    expect(screen.getByText(/都不是击球时刻/)).toBeInTheDocument();
  });

  it("说明里给出**有值的帧数/总帧数** —— 缺了多少要看得见", () => {
    render(<ElbowCurve trace={trace(every40([150, null, null, 130, 120]))} />);
    expect(screen.getByText(/共 3\/5 帧测到肘角/)).toBeInTheDocument();
  });
});
