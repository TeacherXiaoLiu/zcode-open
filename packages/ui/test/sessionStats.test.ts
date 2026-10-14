import { describe, expect, it } from "vitest";
import type { SessionDebugRound } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import {
  formatSessionDurationLabel,
  formatTpsLabel,
  resolveSessionStats,
  resolveSessionToolDurationMs,
} from "@/v4/composer/sessionStats.js";

function round(overrides: Partial<SessionDebugRound>): SessionDebugRound {
  return {
    eventKey: "e",
    requestId: "r",
    requestIndex: 1,
    recordedAt: 0,
    usage: {},
    hitRate: null,
    durationMs: null,
    timeToFirstContentMs: null,
    generationDurationMs: null,
    tokensPerSecond: null,
    ...overrides,
  };
}

function snapshotWithToolDurations(values: readonly (number | undefined)[]): ConversationSnapshot {
  return {
    rows: {
      window: values.map((toolDurationMs, index) => ({
        rowId: index,
        kind: "turnHeader",
        ...(toolDurationMs !== undefined ? { toolDurationMs } : {}),
      })),
    },
  } as unknown as ConversationSnapshot;
}

describe("session stats aggregation", () => {
  it("空数据：四个指标均为 null（工具时长沿用传入值）", () => {
    const summary = resolveSessionStats([], null);
    expect(summary).toEqual({
      modelDurationMs: null,
      toolDurationMs: null,
      avgTimeToFirstTokenMs: null,
      outputTps: null,
    });
    expect(resolveSessionStats([], 61_000).toolDurationMs).toBe(61_000);
  });

  it("按轮聚合：模型用时求和、TTFT 平均、TPS 由总输出 ÷ 总生成时长", () => {
    const rounds = [
      round({
        usage: { outputTokens: 100 },
        durationMs: 5_000,
        timeToFirstContentMs: 1_000,
        generationDurationMs: 4_000,
      }),
      round({
        usage: { outputTokens: 300 },
        durationMs: 7_000,
        timeToFirstContentMs: 2_000,
        generationDurationMs: 5_000,
      }),
    ];
    const summary = resolveSessionStats(rounds, 12_000);
    expect(summary.modelDurationMs).toBe(12_000);
    expect(summary.avgTimeToFirstTokenMs).toBe(1_500);
    expect(summary.outputTps).toBeCloseTo((400 * 1000) / 9_000, 5);
    expect(summary.toolDurationMs).toBe(12_000);
  });

  it("缺失字段的轮不参与对应指标（旧 CLI 无 durationMs/TTFT 时降级为 null）", () => {
    const rounds = [
      round({ usage: { outputTokens: 50 }, generationDurationMs: 2_000 }),
      round({ usage: { outputTokens: 50 }, generationDurationMs: 3_000 }),
    ];
    const summary = resolveSessionStats(rounds, null);
    expect(summary.modelDurationMs).toBeNull();
    expect(summary.avgTimeToFirstTokenMs).toBeNull();
    expect(summary.outputTps).toBeCloseTo(20, 5);
  });

  it("无生成时长或输出时 TPS 为 null", () => {
    expect(
      resolveSessionStats([round({ usage: { outputTokens: 10 } })], null).outputTps,
    ).toBeNull();
    expect(
      resolveSessionStats([round({ generationDurationMs: 1_000 })], null).outputTps,
    ).toBeNull();
  });
});

describe("resolveSessionToolDurationMs", () => {
  it("汇总窗口内 turnHeader 的工具时长；无数据返回 null", () => {
    expect(resolveSessionToolDurationMs(null)).toBeNull();
    expect(resolveSessionToolDurationMs(snapshotWithToolDurations([undefined]))).toBeNull();
    expect(resolveSessionToolDurationMs(snapshotWithToolDurations([3_000, undefined, 4_500]))).toBe(
      7_500,
    );
  });
});

describe("formatSessionDurationLabel", () => {
  it("不足一分钟用一位小数秒（中英文）", () => {
    expect(formatSessionDurationLabel(8_900, "zh-CN")).toBe("8.9秒");
    expect(formatSessionDurationLabel(8_900, "en-US")).toBe("8.9s");
  });

  it("满一分钟用分秒（中英文），59.9 秒进位为 1 分 0 秒", () => {
    expect(formatSessionDurationLabel(23_257_000, "zh-CN")).toBe("387分37秒");
    expect(formatSessionDurationLabel(23_257_000, "en-US")).toBe("387m 37s");
    expect(formatSessionDurationLabel(59_900, "zh-CN")).toBe("1分0秒");
  });

  it("非法值返回 null", () => {
    expect(formatSessionDurationLabel(null, "zh-CN")).toBeNull();
    expect(formatSessionDurationLabel(Number.NaN, "zh-CN")).toBeNull();
    expect(formatSessionDurationLabel(-1, "zh-CN")).toBeNull();
  });
});

describe("formatTpsLabel", () => {
  it("整数 tok/s；null 透传", () => {
    expect(formatTpsLabel(87.4)).toBe("87 tok/s");
    expect(formatTpsLabel(0)).toBe("0 tok/s");
    expect(formatTpsLabel(null)).toBeNull();
  });
});
