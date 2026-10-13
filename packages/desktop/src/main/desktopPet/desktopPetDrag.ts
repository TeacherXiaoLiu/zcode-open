import type { Point } from "electron";
import { PlatformChannels, type DesktopPetDragDirection } from "@zcode/shared";
import type { DesktopPetWindowHandle } from "./desktopPetWindow.js";

/**
 * 桌宠拖动循环（本地定制，specs/desktop/desktop-pet.md）。
 * main 以 16ms 跟随光标移动窗口（全量 delta 相对起点，不累积漂移），
 * 方向变化时推送方向动画；累计位移由 controller 用于区分点击/拖拽与持久化。
 */

const DRAG_TICK_MS = 16;

interface DragSession {
  interval?: ReturnType<typeof setInterval>;
  cursorStart: Point;
  windowStart: { x: number; y: number };
  movedPx: number;
  direction?: DesktopPetDragDirection;
}

export interface DesktopPetDragHandle {
  start(): void;
  end(): { movedPx: number };
  stop(): void;
  isActive(): boolean;
}

export function createDesktopPetDrag(deps: {
  getWindow: () => DesktopPetWindowHandle | null;
  getCursor: () => Point;
  /** 拖动开始时的副作用（如隐藏汇报气泡）。 */
  onStart?: () => void;
}): DesktopPetDragHandle {
  let session: DragSession | null = null;

  function stop(): void {
    if (session?.interval) {
      clearInterval(session.interval);
    }
    session = null;
  }

  function tick(current: DragSession): void {
    const win = deps.getWindow();
    if (!win || win.isDestroyed()) {
      stop();
      return;
    }
    const cursor = deps.getCursor();
    const dx = cursor.x - current.cursorStart.x;
    const dy = cursor.y - current.cursorStart.y;
    if (dx === 0 && dy === 0) {
      return;
    }
    current.movedPx = Math.hypot(dx, dy);
    win.setPosition(current.windowStart.x + dx, current.windowStart.y + dy);
    const direction: DesktopPetDragDirection =
      Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "running-right" : "running-left") : "running";
    if (direction !== current.direction) {
      current.direction = direction;
      win.send(PlatformChannels.DesktopPetDragDirection, direction);
    }
  }

  return {
    start() {
      const win = deps.getWindow();
      if (!win || win.isDestroyed() || session) {
        return;
      }
      deps.onStart?.();
      const bounds = win.getBounds();
      // 先入档再挂 tick：tick 闭包引用同一 session，避免自引用初始化顺序问题。
      const created: DragSession = {
        cursorStart: deps.getCursor(),
        windowStart: { x: bounds.x, y: bounds.y },
        movedPx: 0,
      };
      session = created;
      created.interval = setInterval(() => tick(created), DRAG_TICK_MS);
    },
    end() {
      const current = session;
      stop();
      return { movedPx: current?.movedPx ?? 0 };
    },
    stop,
    isActive: () => session !== null,
  };
}
