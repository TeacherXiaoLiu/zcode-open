import { describe, expect, it } from "vitest";
import {
  createOutputSpeedMeter,
  estimateOutputTokens,
  OUTPUT_SPEED_IDLE_GAP_MS,
  OUTPUT_SPEED_MAX_FRAME_CHARS,
  OUTPUT_SPEED_MAX_TPS,
  OUTPUT_SPEED_RATE_WINDOW_MS,
} from "@/v4/outputSpeedMeter.js";

function createClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

describe("estimateOutputTokens", () => {
  it("英文按 4 字符/token 估算，空白不计", () => {
    expect(estimateOutputTokens("hello world")).toBeCloseTo(2.5, 5);
    expect(estimateOutputTokens("")).toBe(0);
    expect(estimateOutputTokens("   \n\t")).toBe(0);
  });

  it("CJK 按 1 token/字估算", () => {
    expect(estimateOutputTokens("你好世界")).toBe(4);
    expect(estimateOutputTokens("你好 hello")).toBeCloseTo(3.25, 5);
  });
});

describe("output speed meter", () => {
  it("初始无数据：实时与平均均为 null", () => {
    const meter = createOutputSpeedMeter(createClock().now);
    expect(meter.liveTokensPerSecond()).toBeNull();
    expect(meter.averageTokensPerSecond()).toBeNull();
    expect(meter.hasRecentActivity()).toBe(false);
  });

  it("刚开始输出时用实际跨度作分母，窗口填满后按窗口长度稳定", () => {
    const clock = createClock(1_000);
    const meter = createOutputSpeedMeter(clock.now);
    meter.push("你好"); // 2 tokens
    // span = max(500ms 下限, 0) → 2 / 0.5s = 4 tok/s
    expect(meter.liveTokensPerSecond()).toBeCloseTo(4, 5);
    clock.advance(1_000);
    // span = 1s → 2 tok/s
    expect(meter.liveTokensPerSecond()).toBeCloseTo(2, 5);
  });

  it("持续输出时实时速度接近窗口内的实际速率；停止 5 秒后归零", () => {
    const clock = createClock(0);
    const meter = createOutputSpeedMeter(clock.now);
    // 每秒 10 tokens（20 个半角字符）连续 6 秒。
    for (let second = 0; second < 6; second += 1) {
      meter.push("x".repeat(40)); // 10 tokens
      clock.advance(1_000);
    }
    // 窗口 5 秒内 5 个样本（时间 1s..5s）→ 50/5 = 10 tok/s
    expect(meter.liveTokensPerSecond()).toBeCloseTo(10, 0);
    clock.advance(OUTPUT_SPEED_RATE_WINDOW_MS);
    expect(meter.liveTokensPerSecond()).toBeNull();
  });

  it("平均速度按生成段累计：停顿（工具执行等）不计入分母", () => {
    const clock = createClock(0);
    const meter = createOutputSpeedMeter(clock.now);
    // 段 1：0s 与 1s 各 10 tokens，跨度 1s。
    meter.push("x".repeat(40));
    clock.advance(1_000);
    meter.push("x".repeat(40));
    // 停顿 3 秒（超过 IDLE_GAP 视为新段）。
    clock.advance(3_000);
    // 段 2：4s 与 5s 各 10 tokens，跨度 1s。
    meter.push("x".repeat(40));
    clock.advance(1_000);
    meter.push("x".repeat(40));
    // 总 40 tokens / 2s 生成时长 = 20 tok/s，3 秒停顿未计入。
    expect(meter.averageTokensPerSecond()).toBeCloseTo(20, 5);
  });

  it("停顿后新段的实时分子不含旧段样本", () => {
    const clock = createClock(0);
    const meter = createOutputSpeedMeter(clock.now);
    meter.push("x".repeat(400)); // 100 tokens @ 0s
    clock.advance(OUTPUT_SPEED_IDLE_GAP_MS + 500);
    meter.push("x".repeat(4)); // 1 token @ 2.5s（新段）
    // 窗口内仍含旧段大样本，但新段只算 1 token / 500ms 下限 = 2 tok/s。
    expect(meter.liveTokensPerSecond()).toBeCloseTo(2, 5);
  });

  it("超过单帧上限的批量/重放帧不参与统计", () => {
    const clock = createClock(0);
    const meter = createOutputSpeedMeter(clock.now);
    meter.push("x".repeat(OUTPUT_SPEED_MAX_FRAME_CHARS + 1));
    expect(meter.liveTokensPerSecond()).toBeNull();
    expect(meter.averageTokensPerSecond()).toBeNull();
  });

  it("实时速度被 100k tok/s 上限保护（重放挤在一瞬间到达的场景）", () => {
    const clock = createClock(0);
    const meter = createOutputSpeedMeter(clock.now);
    // 50 帧 × 一定量字符在 0ms 内到达：span 取下限 500ms，速率会远超上限。
    for (let index = 0; index < 50; index += 1) {
      meter.push("x".repeat(OUTPUT_SPEED_MAX_FRAME_CHARS));
    }
    expect(meter.liveTokensPerSecond()).toBe(OUTPUT_SPEED_MAX_TPS);
  });

  it("reset 清空全部统计", () => {
    const clock = createClock(0);
    const meter = createOutputSpeedMeter(clock.now);
    meter.push("你好世界");
    clock.advance(500);
    meter.push("你好世界");
    expect(meter.liveTokensPerSecond()).not.toBeNull();
    meter.reset();
    expect(meter.liveTokensPerSecond()).toBeNull();
    expect(meter.averageTokensPerSecond()).toBeNull();
    expect(meter.hasRecentActivity()).toBe(false);
  });

  it("快照导出与恢复：平均口径保留，实时样本不恢复", () => {
    const clock = createClock(0);
    const meter = createOutputSpeedMeter(clock.now);
    // 两段输出：平均 = 40 tokens / 2s = 20 tok/s。
    meter.push("x".repeat(40));
    clock.advance(1_000);
    meter.push("x".repeat(40));
    clock.advance(3_000);
    meter.push("x".repeat(40));
    clock.advance(1_000);
    meter.push("x".repeat(40));
    expect(meter.averageTokensPerSecond()).toBeCloseTo(20, 5);
    const snapshot = meter.snapshotAverage();
    expect(snapshot).toEqual({ totalTokens: 40, totalActiveMs: 2_000 });
    // 模拟切走再回来：新计量器恢复快照，平均值一致，实时为 null（等新输出）。
    const restored = createOutputSpeedMeter(clock.now);
    restored.restoreAverage(snapshot);
    expect(restored.averageTokensPerSecond()).toBeCloseTo(20, 5);
    expect(restored.liveTokensPerSecond()).toBeNull();
    expect(restored.hasRecentActivity()).toBe(false);
    // 新输出继续累加在快照之上。
    clock.advance(10_000);
    restored.push("x".repeat(40));
    clock.advance(1_000);
    restored.push("x".repeat(40));
    // 60 tokens / 3s = 20 tok/s。
    expect(restored.averageTokensPerSecond()).toBeCloseTo(20, 5);
  });

  it("无数据时快照为 null；恢复 null/非法快照等价于清空", () => {
    const clock = createClock(0);
    const meter = createOutputSpeedMeter(clock.now);
    expect(meter.snapshotAverage()).toBeNull();
    meter.push("你好世界");
    clock.advance(500);
    meter.push("你好世界");
    expect(meter.snapshotAverage()).not.toBeNull();
    meter.restoreAverage(null);
    expect(meter.averageTokensPerSecond()).toBeNull();
    expect(meter.liveTokensPerSecond()).toBeNull();
    meter.push("你好世界");
    clock.advance(500);
    meter.push("你好世界");
    meter.restoreAverage({ totalTokens: 0, totalActiveMs: 0 });
    expect(meter.averageTokensPerSecond()).toBeNull();
  });

  it("hasRecentActivity 只在最近窗口内有输出时为真", () => {
    const clock = createClock(0);
    const meter = createOutputSpeedMeter(clock.now);
    meter.push("你好");
    clock.advance(OUTPUT_SPEED_RATE_WINDOW_MS);
    expect(meter.hasRecentActivity()).toBe(true);
    clock.advance(OUTPUT_SPEED_RATE_WINDOW_MS + 1);
    expect(meter.hasRecentActivity()).toBe(false);
  });
});
