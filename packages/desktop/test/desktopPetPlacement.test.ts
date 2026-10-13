import { describe, expect, it } from "vitest";
import {
  DESKTOP_PET_BOTTOM_OFFSET_PX,
  DESKTOP_PET_BUBBLE_GAP_PX,
  DESKTOP_PET_EDGE_MARGIN_PX,
  clampDesktopPetPoint,
  resolveDesktopPetBubbleBounds,
  resolveDesktopPetBounds,
  resolveResizedDesktopPetBounds,
} from "../src/main/desktopPet/desktopPetPlacement.js";

/** 桌宠窗口与气泡的定位算法（三期，specs/desktop/desktop-pet.md）。 */

const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
const petSize = { width: 192, height: 208 };
const bubbleSize = { width: 268, height: 84 };

describe("clampDesktopPetPoint", () => {
  it("把越界坐标夹回工作区", () => {
    expect(clampDesktopPetPoint({ x: -50, y: 5000 }, petSize, workArea)).toEqual({
      x: 0,
      y: 1040 - 208,
    });
  });
});

describe("resolveDesktopPetBounds", () => {
  it("无保存位置时落在工作区右下角（留边 + 底部偏移）", () => {
    expect(resolveDesktopPetBounds({ saved: undefined, size: petSize, workArea })).toEqual({
      width: 192,
      height: 208,
      x: 1920 - 192 - DESKTOP_PET_EDGE_MARGIN_PX,
      y: 1040 - 208 - DESKTOP_PET_BOTTOM_OFFSET_PX,
    });
  });

  it("保存位置来自已拔除显示器时夹回工作区", () => {
    const bounds = resolveDesktopPetBounds({
      saved: { x: -500, y: 5000 },
      size: petSize,
      workArea,
    });
    expect(bounds.x).toBe(0);
    expect(bounds.y).toBe(1040 - 208);
  });

  it("保存位置在屏内时原样保留", () => {
    expect(
      resolveDesktopPetBounds({ saved: { x: 300, y: 400 }, size: petSize, workArea }),
    ).toMatchObject({ x: 300, y: 400 });
  });
});

describe("resolveResizedDesktopPetBounds", () => {
  it("缩放缓动保持底部中心锚定（放大向上生长）", () => {
    const before = { x: 1000, y: 600, width: 192, height: 208 };
    const after = resolveResizedDesktopPetBounds(before, { width: 384, height: 416 }, workArea);
    expect(after.x + after.width / 2).toBe(before.x + before.width / 2);
    expect(after.y + after.height).toBe(before.y + before.height);
  });

  it("缩放后越出工作区时被夹取", () => {
    const before = { x: 1800, y: 900, width: 192, height: 208 };
    expect(resolveResizedDesktopPetBounds(before, { width: 384, height: 416 }, workArea)).toEqual({
      x: 1920 - 384,
      y: 1040 - 416,
      width: 384,
      height: 416,
    });
  });

  it("缩小保持底部中心锚定", () => {
    const before = { x: 1000, y: 600, width: 384, height: 416 };
    const after = resolveResizedDesktopPetBounds(before, petSize, workArea);
    expect(after.x + after.width / 2).toBe(before.x + before.width / 2);
    expect(after.y + after.height).toBe(before.y + before.height);
  });
});

describe("resolveDesktopPetBubbleBounds", () => {
  it("默认挂在宠物左侧（屏幕内侧）", () => {
    const bounds = resolveDesktopPetBubbleBounds(
      { x: 900, y: 600, width: 192, height: 208 },
      bubbleSize,
      workArea,
    );
    expect(bounds).toEqual({
      x: 900 - 268 - DESKTOP_PET_BUBBLE_GAP_PX,
      y: 600,
      width: 268,
      height: 84,
    });
  });

  it("左侧空间不足改挂右侧", () => {
    const bounds = resolveDesktopPetBubbleBounds(
      { x: 4, y: 600, width: 192, height: 208 },
      bubbleSize,
      workArea,
    );
    expect(bounds.x).toBe(4 + 192 + DESKTOP_PET_BUBBLE_GAP_PX);
  });

  it("垂直越界时上移夹取到工作区", () => {
    const bounds = resolveDesktopPetBubbleBounds(
      { x: 900, y: 1030, width: 192, height: 208 },
      bubbleSize,
      workArea,
    );
    expect(bounds.y).toBe(1040 - 84);
  });

  it("窄工作区里右侧也放不下时被夹取", () => {
    // 宠物贴左边缘：左侧无空间被迫走右侧；窄屏下右侧仍越界，最终夹回。
    const narrow = { x: 0, y: 0, width: 400, height: 1040 };
    const bounds = resolveDesktopPetBubbleBounds(
      { x: 100, y: 100, width: 192, height: 208 },
      bubbleSize,
      narrow,
    );
    expect(bounds.x).toBe(400 - 268);
  });
});
