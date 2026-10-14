// 回归：输出速度标签点击后的"会话统计"弹窗（本地定制）。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TID_V4_COMPOSER_SESSION_STATS } from "@zcode/shared";
import { ComposerSessionStatsPanel } from "@/v4/composer/ComposerSessionStatsPanel.js";

const labels: Record<string, string> = {
  "chat.composerOutputSpeed.stats.title": "Session stats",
  "chat.composerOutputSpeed.stats.modelDuration": "Model time",
  "chat.composerOutputSpeed.stats.toolDuration": "Tool time",
  "chat.composerOutputSpeed.stats.ttft": "Avg first token (TTFT)",
  "chat.composerOutputSpeed.stats.tps": "Output speed (TPS)",
};

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: (descriptor: { id: string }) => labels[descriptor.id] ?? descriptor.id,
    },
    locale: "en-US",
  }),
}));

const hoisted = vi.hoisted(() => ({
  debug: {
    rounds: [] as unknown[],
    networkEntries: [] as unknown[],
    cache: null,
    error: false,
  },
}));

vi.mock("@/hooks/useSessionDebug.js", () => ({
  useSessionDebug: () => hoisted.debug,
}));

function debugRound(overrides: Record<string, unknown>): unknown {
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

function renderPanel(readToolDurationMs: () => number | null): string {
  return renderToStaticMarkup(
    createElement(ComposerSessionStatsPanel, {
      enabled: true,
      sessionId: "s1",
      workspacePath: "/workspace",
      readToolDurationMs,
    }),
  );
}

describe("会话统计弹窗", () => {
  it("渲染四个指标（模型用时/TTFT/输出速度为聚合值，工具时长来自投影）", () => {
    hoisted.debug.rounds = [
      debugRound({
        usage: { outputTokens: 100 },
        durationMs: 5_000,
        timeToFirstContentMs: 1_000,
        generationDurationMs: 4_000,
      }),
      debugRound({
        usage: { outputTokens: 300 },
        durationMs: 7_000,
        timeToFirstContentMs: 2_000,
        generationDurationMs: 5_000,
      }),
    ];
    const html = renderPanel(() => 61_000);
    expect(html).toContain(TID_V4_COMPOSER_SESSION_STATS);
    expect(html).toContain("Session stats");
    expect(html).toContain("Model time");
    expect(html).toContain("12.0s");
    expect(html).toContain("Tool time");
    expect(html).toContain("1m 1s");
    expect(html).toContain("Avg first token (TTFT)");
    expect(html).toContain("1.5s");
    expect(html).toContain("Output speed (TPS)");
    expect(html).toContain("44 tok/s");
  });

  it("数据缺失时渲染占位符而不是空行", () => {
    hoisted.debug.rounds = [];
    const html = renderPanel(() => null);
    expect(html).toContain(TID_V4_COMPOSER_SESSION_STATS);
    expect(html.match(/—/g)).toHaveLength(4);
  });
});
