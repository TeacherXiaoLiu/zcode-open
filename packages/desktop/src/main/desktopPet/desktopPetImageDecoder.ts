import { BrowserWindow } from "electron";

/** Chromium 能解码 WebP，Electron nativeImage 只接受 PNG/JPEG，不能承担宠物图集校验。 */
export function createDesktopPetImageDecoder() {
  let current: BrowserWindow | undefined;
  let tail = Promise.resolve();
  let disposed = false;

  return {
    ownsWindow(candidate: BrowserWindow): boolean {
      return candidate === current;
    },
    async decode(bytes: Buffer): Promise<{ width: number; height: number } | null> {
      let result: { width: number; height: number } | null = null;
      const task = tail
        .catch(() => undefined)
        .then(async () => {
          if (disposed) return;
          const win = new BrowserWindow({
            show: false,
            frame: false,
            focusable: false,
            skipTaskbar: true,
            webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
          });
          current = win;
          const timeout = setTimeout(() => {
            if (!win.isDestroyed()) win.destroy();
          }, 10_000);
          try {
            await win.loadURL(
              "data:text/html,<meta http-equiv='Content-Security-Policy' content=\"default-src 'none'\">宠物图集校验",
            );
            result = await win.webContents.executeJavaScript(`(async () => {
            try {
              const binary = atob(${JSON.stringify(bytes.toString("base64"))});
              const data = Uint8Array.from(binary, (char) => char.charCodeAt(0));
              const image = await createImageBitmap(new Blob([data], { type: 'image/webp' }));
              const size = { width: image.width, height: image.height };
              image.close();
              return size;
            } catch { return null; }
          })()`);
          } catch {
            result = null;
          } finally {
            clearTimeout(timeout);
            if (!win.isDestroyed()) win.destroy();
            if (current === win) current = undefined;
          }
        });
      tail = task;
      await task;
      return result;
    },
    dispose(): void {
      disposed = true;
      if (current && !current.isDestroyed()) current.destroy();
      current = undefined;
    },
  };
}
