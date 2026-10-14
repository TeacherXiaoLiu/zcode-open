import { describe, expect, it } from "vitest";
import {
  formatContextCacheHitRateLabel,
  formatContextUsageSummary,
  formatContextUsageTokenCount,
  resolveCumulativeTokenUsagePanel,
} from "@/chat-input-toolbar/contextUsage.js";
import { runContextPanelActionWithClose } from "@/chat-input-toolbar/contextPanelAction.js";
import { formatGroupedTokenNumber } from "@/lib/tokenNumberFormat.js";

describe("chat input context usage formatting", () => {
  it("uses uppercase English compact units", () => {
    expect(formatContextUsageTokenCount(1_250, "en-US")).toBe("1.3K");
    expect(formatContextUsageTokenCount(1_500_000, "en-US")).toBe("1.5M");
    expect(formatContextUsageTokenCount(2_300_000_000, "en-US")).toBe("2.3B");
  });

  it("renders the context window summary with integer compact total", () => {
    expect(
      formatContextUsageSummary({
        locale: "en-US",
        percent: 0.125,
        size: 1_000_000,
        used: 125_000,
      }),
    ).toBe("125K/1M (12.5%)");
  });

  it("uses localized compact token units for Chinese locale", () => {
    expect(
      formatContextUsageSummary({
        locale: "zh-CN",
        percent: 0.125,
        size: 1_000_000,
        used: 125_000,
      }),
    ).toBe("12.5万/100万 (12.5%)");
  });

  it("only renders cache hit rate at 78 percent or above", () => {
    expect(formatContextCacheHitRateLabel(0.779, "en-US")).toBeNull();
    expect(formatContextCacheHitRateLabel(0.78, "en-US")).toBe("78%");
    expect(formatContextCacheHitRateLabel(0.781, "en-US")).toBe("78.1%");
    expect(formatContextCacheHitRateLabel(null, "en-US")).toBeNull();
  });

  it("closes the context panel before running an inner action", () => {
    const calls: string[] = [];

    runContextPanelActionWithClose({
      action: () => calls.push("action"),
      close: () => calls.push("close"),
    });

    expect(calls).toEqual(["close", "action"]);
  });
});

describe("token usage panel derivation", () => {
  it("derives totals, uncached input and cache hit rate from cumulative counts", () => {
    // 真实数据样例（本地 DB）：inputTokens 是含缓存的 total（input + output = computed_total）。
    const panel = resolveCumulativeTokenUsagePanel({
      inputTokens: 5_195_314,
      outputTokens: 22_145,
      cacheReadTokens: 5_135_104,
      cacheWriteTokens: 0,
    });
    expect(panel).not.toBeNull();
    expect(panel?.total).toBe(5_217_459);
    expect(panel?.uncachedInputTokens).toBe(60_210);
    expect(panel?.cacheHitRate).toBeCloseTo(5_135_104 / 5_195_314, 6);
    expect(panel?.cacheReadTokens).toBe(5_135_104);
    expect(panel?.cacheWriteTokens).toBe(0);
    expect(panel?.outputTokens).toBe(22_145);
  });

  it("returns null for missing or empty usage and clamps uncached input at zero", () => {
    expect(resolveCumulativeTokenUsagePanel(null)).toBeNull();
    expect(
      resolveCumulativeTokenUsagePanel({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeNull();
    const clamped = resolveCumulativeTokenUsagePanel({
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 80,
      cacheWriteTokens: 50,
    });
    expect(clamped?.uncachedInputTokens).toBe(0);
  });

  it("groups full token numbers per locale", () => {
    expect(formatGroupedTokenNumber("en-US", 464_870_066)).toBe("464,870,066");
    expect(formatGroupedTokenNumber("zh-CN", 12_345)).toBe("12,345");
    expect(formatGroupedTokenNumber("en-US", Number.NaN)).toBe("");
  });
});
