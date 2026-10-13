/**
 * 桌宠会话汇报气泡渲染器（三期，specs/desktop/desktop-pet.md）。
 * 渲染"会话列表：状态色点 + 标题 + 最新助手回复摘要"；显示/隐藏与窗口高度由 main 决定。
 * 文案内置 zh-CN/en-US 两份映射（main 在推送里带上 locale），不引入完整 i18n 框架。
 */
import type {
  DesktopPetBubblePayload,
  DesktopPetSessionActivity,
  DesktopPetState,
  Locale,
} from "@zcode/shared";

interface DesktopPetBubbleBridge {
  getActivity(): Promise<DesktopPetBubblePayload>;
  onActivity(callback: (payload: DesktopPetBubblePayload) => void): () => void;
}

declare global {
  interface Window {
    desktopPetBubble?: DesktopPetBubbleBridge;
  }
}

interface BubbleLabels {
  status: Record<Exclude<DesktopPetState, "idle">, string>;
  untitled: string;
}

const LABELS: Record<Locale, BubbleLabels> = {
  "zh-CN": {
    status: {
      running: "正在工作",
      failed: "出错了",
      review: "等待查看",
      waiting: "等待中",
    },
    untitled: "未命名会话",
  },
  "en-US": {
    status: {
      running: "Working",
      failed: "Failed",
      review: "Ready to review",
      waiting: "Waiting",
    },
    untitled: "Untitled session",
  },
};

function createRow(session: DesktopPetSessionActivity, labels: BubbleLabels): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "row";
  row.dataset["state"] = session.state;
  const dot = document.createElement("span");
  dot.className = "dot";
  const body = document.createElement("div");
  body.className = "body";
  const head = document.createElement("div");
  head.className = "head";
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = session.title || labels.untitled;
  const status = document.createElement("span");
  status.className = "status";
  status.textContent =
    session.state === "idle" ? "" : (labels.status[session.state] ?? session.state);
  head.append(title, status);
  body.append(head);
  if (session.detail) {
    const detail = document.createElement("div");
    detail.className = "detail";
    detail.textContent = session.detail;
    body.append(detail);
  }
  row.append(dot, body);
  return row;
}

function render(payload: DesktopPetBubblePayload): void {
  const list = document.getElementById("list");
  if (!list) {
    return;
  }
  const labels = LABELS[payload.locale] ?? LABELS["en-US"];
  // 全部走 textContent 构造：会话标题/摘要来自用户与模型内容，绝不拼接 HTML。
  list.replaceChildren(...payload.activity.sessions.map((session) => createRow(session, labels)));
}

async function boot(): Promise<void> {
  const bridge = window.desktopPetBubble;
  if (!bridge) {
    return;
  }
  try {
    render(await bridge.getActivity());
  } catch {
    // 主进程尚未就绪：保持空卡，等待首次推送。
  }
  bridge.onActivity(render);
}

void boot();
