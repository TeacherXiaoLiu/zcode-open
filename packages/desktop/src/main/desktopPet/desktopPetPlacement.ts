import type { Rectangle } from "electron";

/**
 * 桌宠窗口纯定位计算（本地定制，specs/desktop/desktop-pet.md）。
 * 不依赖 Electron 运行时（只借用 Rectangle 类型），便于单测覆盖：
 * 初始定位、缩放缓动、气泡挂靠都只做"取工作区 → 夹取"的算术。
 */

export interface DesktopPetSize {
  width: number;
  height: number;
}

export interface DesktopPetPoint {
  x: number;
  y: number;
}

/** 默认位置：主显示器右下角（留边 24px，底部抬高 96px 避开任务栏区）。 */
export const DESKTOP_PET_EDGE_MARGIN_PX = 24;
export const DESKTOP_PET_BOTTOM_OFFSET_PX = 96;

/** 气泡与宠物的间距。 */
export const DESKTOP_PET_BUBBLE_GAP_PX = 8;

/** 把候选位置夹取到工作区，保证窗口完整可见。 */
export function clampDesktopPetPoint(
  candidate: DesktopPetPoint,
  size: DesktopPetSize,
  workArea: Rectangle,
): DesktopPetPoint {
  return {
    x: Math.round(
      Math.min(Math.max(candidate.x, workArea.x), workArea.x + workArea.width - size.width),
    ),
    y: Math.round(
      Math.min(Math.max(candidate.y, workArea.y), workArea.y + workArea.height - size.height),
    ),
  };
}

/** 初始 bounds：保存位置优先，否则工作区右下角；最终夹取到目标显示器工作区。 */
export function resolveDesktopPetBounds(params: {
  saved: DesktopPetPoint | undefined;
  size: DesktopPetSize;
  workArea: Rectangle;
}): Rectangle {
  const { saved, size, workArea } = params;
  const candidate = saved ?? {
    x: workArea.x + workArea.width - size.width - DESKTOP_PET_EDGE_MARGIN_PX,
    y: workArea.y + workArea.height - size.height - DESKTOP_PET_BOTTOM_OFFSET_PX,
  };
  const clamped = clampDesktopPetPoint(candidate, size, workArea);
  return { x: clamped.x, y: clamped.y, width: size.width, height: size.height };
}

/** 缩放缓动：以窗口底部中心为锚（宠物"站在地面"上，放大向上生长），再夹取到工作区。 */
export function resolveResizedDesktopPetBounds(
  current: Rectangle,
  nextSize: DesktopPetSize,
  workArea: Rectangle,
): Rectangle {
  const clamped = clampDesktopPetPoint(
    {
      x: current.x + current.width / 2 - nextSize.width / 2,
      y: current.y + current.height - nextSize.height,
    },
    nextSize,
    workArea,
  );
  return { x: clamped.x, y: clamped.y, width: nextSize.width, height: nextSize.height };
}

/** 气泡挂靠：优先宠物左侧（默认宠物在屏幕右下角，气泡朝屏幕内侧），左侧空间不足放右侧。 */
export function resolveDesktopPetBubbleBounds(
  petBounds: Rectangle,
  bubbleSize: DesktopPetSize,
  workArea: Rectangle,
): Rectangle {
  let x = petBounds.x - bubbleSize.width - DESKTOP_PET_BUBBLE_GAP_PX;
  if (x < workArea.x) {
    x = petBounds.x + petBounds.width + DESKTOP_PET_BUBBLE_GAP_PX;
  }
  const clamped = clampDesktopPetPoint({ x, y: petBounds.y }, bubbleSize, workArea);
  return { x: clamped.x, y: clamped.y, width: bubbleSize.width, height: bubbleSize.height };
}
