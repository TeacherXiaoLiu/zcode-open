import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_TITLE_REFRESH,
  buildTitleRefreshInputText,
  describeSessionTitleRefresh,
  isTitleRefreshDueAtRound,
  normalizeSessionTitleRefreshConfig,
  selectTitleRefreshSamples,
} from "../src/runtime/methods/title-refresh-schedule.js";

describe("normalizeSessionTitleRefreshConfig", () => {
  it("returns defaults without input", () => {
    expect(normalizeSessionTitleRefreshConfig()).toEqual(DEFAULT_SESSION_TITLE_REFRESH);
  });

  it("clamps out-of-range and unparsable values", () => {
    expect(normalizeSessionTitleRefreshConfig({ firstRound: 0 }).firstRound).toBe(1);
    expect(normalizeSessionTitleRefreshConfig({ firstRound: 51 }).firstRound).toBe(50);
    expect(normalizeSessionTitleRefreshConfig({ interval: 101 }).interval).toBe(100);
    expect(
      normalizeSessionTitleRefreshConfig({ firstRound: "3" as unknown as number }).firstRound,
    ).toBe(3);
    expect(
      normalizeSessionTitleRefreshConfig({ firstRound: Number.NaN }).firstRound,
    ).toBe(DEFAULT_SESSION_TITLE_REFRESH.firstRound);
    // enabled 只接受布尔，其他类型回退默认
    expect(
      normalizeSessionTitleRefreshConfig({ enabled: "yes" as unknown as boolean }).enabled,
    ).toBe(true);
  });

  it("applies later layers with higher priority", () => {
    const merged = normalizeSessionTitleRefreshConfig(
      { firstRound: 5, interval: 10, enabled: true },
      { firstRound: 3 },
    );
    expect(merged).toEqual({ enabled: true, firstRound: 3, interval: 10 });
  });

  it("passes through modelSelection only when explicitly provided", () => {
    // 有值保留：低优先级来源的模型不被高优先级来源抹掉（高优先级未提供该字段）。
    const modelSelection = {
      providerId: "opencode-go-responses",
      modelId: "muse-spark-1.3-contributor",
    };
    expect(normalizeSessionTitleRefreshConfig({ modelSelection }).modelSelection).toEqual(
      modelSelection,
    );
    expect(
      normalizeSessionTitleRefreshConfig({ modelSelection }, { firstRound: 4 }).modelSelection,
    ).toEqual(modelSelection);
    // null/缺席都不写入：读取方按「跟随会话当前模型」处理，不会留下空字段。
    expect("modelSelection" in normalizeSessionTitleRefreshConfig({ modelSelection: null })).toBe(
      false,
    );
    expect("modelSelection" in normalizeSessionTitleRefreshConfig({})).toBe(false);
  });
});

describe("isTitleRefreshDueAtRound", () => {
  const config = { enabled: true, firstRound: 3, interval: 5 };

  it("fires exactly on the absolute grid", () => {
    expect(isTitleRefreshDueAtRound(1, config)).toBe(false);
    expect(isTitleRefreshDueAtRound(2, config)).toBe(false);
    expect(isTitleRefreshDueAtRound(3, config)).toBe(true);
    expect(isTitleRefreshDueAtRound(4, config)).toBe(false);
    expect(isTitleRefreshDueAtRound(7, config)).toBe(false);
    expect(isTitleRefreshDueAtRound(8, config)).toBe(true);
    expect(isTitleRefreshDueAtRound(13, config)).toBe(true);
    expect(isTitleRefreshDueAtRound(18, config)).toBe(true);
  });

  it("never fires when disabled or rounds invalid", () => {
    expect(isTitleRefreshDueAtRound(3, { ...config, enabled: false })).toBe(false);
    expect(isTitleRefreshDueAtRound(0, config)).toBe(false);
    expect(isTitleRefreshDueAtRound(-1, config)).toBe(false);
    expect(isTitleRefreshDueAtRound(Number.NaN, config)).toBe(false);
  });

  it("does not catch up history after parameter change", () => {
    // 参数从 first=5/int=10 改成 first=3/int=5 时，当前 rounds=7 不在新网格（3,8,13…）上
    const rescheduled = normalizeSessionTitleRefreshConfig({
      firstRound: 3,
      interval: 5,
      enabled: true,
    });
    expect(isTitleRefreshDueAtRound(7, rescheduled)).toBe(false);
    expect(isTitleRefreshDueAtRound(8, rescheduled)).toBe(true);
  });

  it("fires every round after first when interval is 1", () => {
    const every = { enabled: true, firstRound: 4, interval: 1 };
    expect(isTitleRefreshDueAtRound(3, every)).toBe(false);
    expect(isTitleRefreshDueAtRound(4, every)).toBe(true);
    expect(isTitleRefreshDueAtRound(5, every)).toBe(true);
    expect(isTitleRefreshDueAtRound(9, every)).toBe(true);
  });
});

describe("describeSessionTitleRefresh", () => {
  it("describes enabled and disabled states", () => {
    expect(describeSessionTitleRefresh({ enabled: true, firstRound: 3, interval: 5 })).toBe(
      "第 3 轮首次刷新，之后每 5 轮刷新一次",
    );
    expect(describeSessionTitleRefresh({ enabled: false, firstRound: 3, interval: 5 })).toBe(
      "已停用 · 第 3 轮首次刷新，之后每 5 轮刷新一次",
    );
    expect(describeSessionTitleRefresh({ enabled: true, firstRound: 2, interval: 1 })).toBe(
      "第 2 轮首次刷新，之后每轮刷新一次",
    );
  });
});

describe("selectTitleRefreshSamples", () => {
  it("keeps all short sessions", () => {
    expect(selectTitleRefreshSamples(["a", "b", "c"], 8)).toEqual(["a", "b", "c"]);
  });

  it("keeps head plus most recent for long sessions", () => {
    const texts = Array.from({ length: 20 }, (_, index) => `m${index + 1}`);
    const picked = selectTitleRefreshSamples(texts, 5);
    expect(picked).toEqual(["m1", "m17", "m18", "m19", "m20"]);
  });

  it("filters blank entries and normalizes tiny windows", () => {
    expect(selectTitleRefreshSamples(["a", "  ", "b"], 8)).toEqual(["a", "b"]);
    const picked = selectTitleRefreshSamples(["a", "b", "c", "d"], 1);
    expect(picked).toEqual(["a", "d"]);
  });
});

describe("buildTitleRefreshInputText", () => {
  it("frames samples as a JSON array with a stable header", () => {
    const text = buildTitleRefreshInputText(["第一条", "最近一条"], 1200);
    expect(text).toContain("Session title refresh samples");
    expect(text).toContain("[\"第一条\",\"最近一条\"]");
  });

  it("drops middle items before touching head and tail", () => {
    const texts = Array.from({ length: 30 }, (_, index) => `信息条目-${index + 1} `.repeat(8));
    const text = buildTitleRefreshInputText(texts, 600);
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).toContain("信息条目-1 ");
    expect(text).toContain("信息条目-30 ");
  });

  it("truncates single oversized messages within budget", () => {
    const huge = "很长的一条消息".repeat(500);
    const text = buildTitleRefreshInputText([huge, huge], 400);
    expect(text.length).toBeLessThanOrEqual(400);
  });

  it("returns empty for blank input", () => {
    expect(buildTitleRefreshInputText([" ", ""], 1200)).toBe("");
  });
});