/**
 * 桌面宠物渲染器（本地定制，specs/desktop/desktop-pet.md）。
 * canvas 2D 按 16ms tick 从 Codex pet 图集绘制当前帧；交互（单击挥手 / 双击开主窗 /
 * 拖拽行走 / 右键菜单 / 空闲环视）对齐 Mikiko 桌面版实测行为；会话状态动画由 main 推送。
 */
import {
  DESKTOP_PET_DEFAULT_ANIMATIONS,
  type DesktopPetActivePayload,
  type DesktopPetDragDirection,
  type DesktopPetManifest,
  type DesktopPetState,
} from "@zcode/shared";

interface DesktopPetBridge {
  getActive(): Promise<DesktopPetActivePayload | undefined>;
  dragStart(): void;
  dragEnd(): Promise<{ movedPx: number }>;
  contextMenu(): void;
  openApp(): void;
  onState(callback: (state: DesktopPetState | "waving") => void): () => void;
  onDragDirection(callback: (direction: DesktopPetDragDirection) => void): () => void;
}

declare global {
  interface Window {
    desktopPet?: DesktopPetBridge;
  }
}

const FRAME_TICK_MS = 16;
const CLICK_MOVE_THRESHOLD_PX = 6;
const DOUBLE_CLICK_WINDOW_MS = 400;
const WAVING_HOLD_MS = 3200;
const LOOK_CHECK_INTERVAL_MS = 2000;
const LOOK_MIN_IDLE_MS = 20_000;
const LOOK_MAX_IDLE_MS = 40_000;

interface Clip {
  frames: Array<{ spriteIndex: number; durationMs: number }>;
  loop: boolean;
}

/** 从图集默认表构建帧表；v1 图集没有 look，行数不足时跳过。 */
function buildClips(pet: DesktopPetManifest): Map<string, Clip> {
  const clips = new Map<string, Clip>();
  for (const [name, def] of Object.entries(DESKTOP_PET_DEFAULT_ANIMATIONS)) {
    if (def.v2Only && pet.spriteVersionNumber !== 2) continue;
    if (def.row >= pet.rows) continue;
    const frames: Array<{ spriteIndex: number; durationMs: number }> = [];
    for (let index = 0; index < def.frames; index += 1) {
      const spriteIndex = def.row * pet.columns + index;
      if (spriteIndex >= pet.frameCount) break;
      frames.push({ spriteIndex, durationMs: def.frameMs });
    }
    if (frames.length > 0) {
      // waving 循环播放 + 3.2s 超时回退（观感是"挥手挥几遍"）；其余一次性动画停末帧。
      clips.set(name, { frames, loop: name === "waving" ? true : !def.oneShot });
    }
  }
  return clips;
}

class PetAnimator {
  private readonly clips: Map<string, Clip>;
  private clip: Clip | null = null;
  private startedAt = 0;
  current = "idle";

  constructor(clips: Map<string, Clip>, initial: DesktopPetState) {
    this.clips = clips;
    this.play(initial);
  }

  play(name: string): void {
    if (this.current === name && this.clip?.loop) {
      return;
    }
    const clip = this.clips.get(name) ?? this.clips.get("idle") ?? null;
    if (!clip) return;
    this.clip = clip;
    this.current = this.clips.has(name) ? name : "idle";
    this.startedAt = performance.now();
  }

  has(name: string): boolean {
    return this.clips.has(name);
  }

  /** one-shot 动画播放一遍的自然时长（look 等超时回退用）。 */
  durationOf(name: string): number {
    const clip = this.clips.get(name);
    if (!clip) return 0;
    return clip.frames.reduce((sum, frame) => sum + frame.durationMs, 0);
  }

  tick(now: number): number {
    const clip = this.clip;
    if (!clip || clip.frames.length === 0) return 0;
    const total = clip.frames.reduce((sum, frame) => sum + frame.durationMs, 0);
    let elapsed = Math.max(0, now - this.startedAt);
    if (clip.loop) {
      elapsed %= total;
    } else {
      elapsed = Math.min(elapsed, total - 1);
    }
    let accumulated = 0;
    for (const frame of clip.frames) {
      accumulated += frame.durationMs;
      if (elapsed < accumulated) return frame.spriteIndex;
    }
    return clip.frames[clip.frames.length - 1]?.spriteIndex ?? 0;
  }
}

async function boot(): Promise<void> {
  const bridge = window.desktopPet;
  const canvas = document.getElementById("stage") as HTMLCanvasElement | null;
  if (!bridge || !canvas) {
    return;
  }
  const active = await bridge.getActive();
  if (!active) {
    return;
  }
  const { pet, spritesheetUrl, state } = active;

  const image = new Image();
  image.src = spritesheetUrl;
  await new Promise<void>((resolve) => {
    image.onload = () => resolve();
    image.onerror = () => resolve();
  });
  if (image.naturalWidth === 0) {
    // 精灵表加载失败或内容不是图片：留空窗；petpack 协议的错误在 main 侧同样可见。
    console.error("[desktop-pet] spritesheet failed to load", { spritesheetUrl });
    return;
  }
  // 图集网格必须精确覆盖（pet-format 契约）；不符则不播放，避免花图。
  if (
    image.naturalWidth !== pet.columns * pet.frameWidth ||
    image.naturalHeight !== pet.rows * pet.frameHeight
  ) {
    console.error("[desktop-pet] spritesheet size mismatch", {
      expectedWidth: pet.columns * pet.frameWidth,
      expectedHeight: pet.rows * pet.frameHeight,
      actualWidth: image.naturalWidth,
      actualHeight: image.naturalHeight,
    });
    return;
  }

  // 画布像素缓冲必须与容器的 CSS 尺寸保持同步：绘制时是把 192×208 的格子
  // 拉伸到 canvas.width/height，一旦缓冲尺寸与 clientWidth/Height 失配，画面就会
  // 被等比放大（曾出现"反复点击宠物越来越大"）。窗口尺寸会因缩放设置、显示器 DPI
  // 变化、透明窗口首次显示重算而改变，因此不能只在启动时算一次。
  let dpr = window.devicePixelRatio || 1;
  function syncCanvasSize(): void {
    const nextDpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * nextDpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * nextDpr));
    if (canvas.width === width && canvas.height === height && dpr === nextDpr) {
      return;
    }
    // 只有尺寸真的变化才写 width/height：赋值会清空画布并重置上下文状态。
    dpr = nextDpr;
    canvas.width = width;
    canvas.height = height;
  }
  syncCanvasSize();
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  const resizeObserver =
    typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(syncCanvasSize);
  resizeObserver?.observe(canvas);
  window.addEventListener("resize", syncCanvasSize);

  const animator = new PetAnimator(buildClips(pet), state);
  let statusState: DesktopPetState = state;
  let dragging = false;
  let activePointerId: number | undefined;
  let oneShotTimer: ReturnType<typeof setTimeout> | undefined;
  let lastClickAt = 0;
  let lastLookAt = performance.now() + randomLookDelay();

  function randomLookDelay(): number {
    return LOOK_MIN_IDLE_MS + Math.random() * (LOOK_MAX_IDLE_MS - LOOK_MIN_IDLE_MS);
  }

  function cancelOneShot(): void {
    if (oneShotTimer !== undefined) {
      clearTimeout(oneShotTimer);
      oneShotTimer = undefined;
    }
  }

  function playStatus(): void {
    if (!dragging) {
      animator.play(statusState);
    }
  }

  function playOneShot(name: string, holdMs: number): void {
    animator.play(name);
    cancelOneShot();
    oneShotTimer = setTimeout(() => {
      oneShotTimer = undefined;
      playStatus();
    }, holdMs);
  }

  // 主循环：从图集绘制当前帧（拉伸到整窗，dpr 已在 canvas 尺寸里）。
  window.setInterval(() => {
    // 兜底：ResizeObserver/resize 事件在透明窗口与高 DPI 切换下可能漏发，
    // 每帧比对一次 CSS 尺寸，避免缓冲失配把宠物拉伸放大。
    syncCanvasSize();
    const spriteIndex = animator.tick(performance.now());
    const column = spriteIndex % pet.columns;
    const row = Math.floor(spriteIndex / pet.columns);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      image,
      column * pet.frameWidth,
      row * pet.frameHeight,
      pet.frameWidth,
      pet.frameHeight,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  }, FRAME_TICK_MS);

  // 空闲环视：仅 v2 图集；每 20-40 秒随机一次（idle 期间）。
  window.setInterval(() => {
    if (dragging || oneShotTimer !== undefined || animator.current !== "idle") {
      return;
    }
    if (!animator.has("look")) {
      return;
    }
    if (performance.now() < lastLookAt) {
      return;
    }
    lastLookAt = performance.now() + randomLookDelay();
    playOneShot("look", animator.durationOf("look") + 150);
  }, LOOK_CHECK_INTERVAL_MS);

  // 状态下发：waving 为 one-shot；其余直接切换。拖动中只更新口径不抢动画。
  bridge.onState((incoming) => {
    if (incoming === "waving") {
      if (!dragging) {
        playOneShot("waving", WAVING_HOLD_MS);
      }
      return;
    }
    statusState = incoming;
    if (dragging) {
      return;
    }
    cancelOneShot();
    animator.play(incoming);
  });

  // 拖动方向动画由 main 在拖动循环里推送。
  bridge.onDragDirection((direction) => {
    animator.play(direction);
  });

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    activePointerId = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    dragging = true;
    document.body.classList.add("dragging");
    bridge.dragStart();
  });

  const finishPointer = (event: PointerEvent): void => {
    if (!dragging || event.pointerId !== activePointerId) {
      return;
    }
    activePointerId = undefined;
    dragging = false;
    document.body.classList.remove("dragging");
    void (async () => {
      let movedPx = Number.POSITIVE_INFINITY;
      try {
        movedPx = (await bridge.dragEnd()).movedPx;
      } catch {
        // main 不可用按拖拽处理：只回状态动画，不做点击判定。
      }
      if (movedPx > CLICK_MOVE_THRESHOLD_PX) {
        cancelOneShot();
        playStatus();
        return;
      }
      const now = performance.now();
      if (now - lastClickAt < DOUBLE_CLICK_WINDOW_MS) {
        lastClickAt = 0;
        bridge.openApp();
        return;
      }
      lastClickAt = now;
      playOneShot("waving", WAVING_HOLD_MS);
    })();
  };
  canvas.addEventListener("pointerup", finishPointer);
  canvas.addEventListener("pointercancel", finishPointer);
  canvas.addEventListener("lostpointercapture", finishPointer);

  canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    activePointerId = undefined;
    dragging = false;
    document.body.classList.remove("dragging");
    void bridge.dragEnd().catch(() => undefined);
    bridge.contextMenu();
  });
}

void boot();