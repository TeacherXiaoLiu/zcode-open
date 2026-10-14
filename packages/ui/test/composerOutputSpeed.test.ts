// 回归：输入框工具栏内的输出速度标签（本地定制）。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TID_V4_COMPOSER_OUTPUT_SPEED } from "@zcode/shared";
import { ComposerOutputSpeed } from "@/v4/composer/ComposerOutputSpeed.js";
import { createOutputSpeedMeter } from "@/v4/outputSpeedMeter.js";

const labels: Record<string, string> = {
  "chat.composerOutputSpeed.live": "Live",
  "chat.composerOutputSpeed.average": "Avg",
  "chat.composerOutputSpeed.hint": "Rolling estimate",
};

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: (descriptor: { id: string }) => labels[descriptor.id] ?? descriptor.id,
    },
    locale: "en-US",
  }),
}));

function createClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

describe("输入框输出速度标签", () => {
  it("计量器为 null 时不渲染", () => {
    const html = renderToStaticMarkup(createElement(ComposerOutputSpeed, { meter: null }));
    expect(html).toBe("");
  });

  it("没有任何输出数据时不渲染（不占位）", () => {
    const meter = createOutputSpeedMeter(createClock().now);
    const html = renderToStaticMarkup(createElement(ComposerOutputSpeed, { meter }));
    expect(html).not.toContain(TID_V4_COMPOSER_OUTPUT_SPEED);
  });

  it("有输出时同时渲染实时与平均速度（走 i18n 标签）", () => {
    const clock = createClock(0);
    const meter = createOutputSpeedMeter(clock.now);
    meter.push("你好世界".repeat(5)); // 20 tokens
    clock.advance(500);
    meter.push("hello world"); // 2.5 tokens
    const html = renderToStaticMarkup(createElement(ComposerOutputSpeed, { meter }));
    expect(html).toContain(TID_V4_COMPOSER_OUTPUT_SPEED);
    expect(html).toContain("<button");
    expect(html).toContain("Live");
    expect(html).toContain("Avg");
    expect(html).toContain("tok/s");
    expect(html).toContain(labels["chat.composerOutputSpeed.hint"]);
  });

  it("输出停止一段时间后只保留平均速度", () => {
    const clock = createClock(0);
    const meter = createOutputSpeedMeter(clock.now);
    meter.push("你好世界".repeat(5));
    clock.advance(500);
    meter.push("你好世界".repeat(5));
    clock.advance(30_000);
    const html = renderToStaticMarkup(createElement(ComposerOutputSpeed, { meter }));
    expect(html).toContain(TID_V4_COMPOSER_OUTPUT_SPEED);
    expect(html).toContain("Avg");
    expect(html).not.toContain("Live");
  });

  it("提供统计数据源时可交互展开（关闭态只渲染触发标签）", () => {
    const clock = createClock(0);
    const meter = createOutputSpeedMeter(clock.now);
    meter.push("你好世界");
    clock.advance(500);
    meter.push("你好世界");
    const html = renderToStaticMarkup(
      createElement(ComposerOutputSpeed, {
        meter,
        stats: {
          sessionId: "s1",
          workspacePath: "/workspace",
          readToolDurationMs: () => null,
        },
      }),
    );
    expect(html).toContain(TID_V4_COMPOSER_OUTPUT_SPEED);
    expect(html).toContain("<button");
  });
});
