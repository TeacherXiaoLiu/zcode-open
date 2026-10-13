import { realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { DESKTOP_PET_ID_PATTERN, DESKTOP_PET_SPRITESHEET_FILE } from "./desktopPetCatalog.js";

/**
 * petpack:// 自定义协议（本地定制，specs/desktop/desktop-pet.md）：
 * pet 窗口只允许通过 petpack://<pet-id>/spritesheet.webp 加载精灵表，
 * 不能携带任意文件路径。
 *
 * 安全约束对齐 localMediaPreviewProtocol 的教训（URL 里的绝对路径 = 任意文件读取）：
 * 主机名必须是合法 pet-id、路径必须是固定文件名、真实路径必须落在 pets 根之内
 * （realpath 校验顺带压掉符号链接逃逸）。
 */

export const DESKTOP_PET_PACK_SCHEME = "petpack";

/** registerSchemesAsPrivileged 的 petpack 条目（standard 是 URL host/path 解析生效的前提）。 */
export const DESKTOP_PET_PACK_PRIVILEGED_SCHEME = {
  scheme: DESKTOP_PET_PACK_SCHEME,
  privileges: { standard: true, secure: true },
} as const;

const NET_ERR_FILE_NOT_FOUND = -6;

interface DesktopPetPackProtocol {
  registerFileProtocol(
    scheme: string,
    handler: (
      request: { url: string },
      callback: (response: string | { error: number }) => void,
    ) => void,
  ): boolean;
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function installDesktopPetPackProtocol(
  protocol: DesktopPetPackProtocol,
  options: { petsRootDir: string; marketPreviewRootDir?: string },
): void {
  protocol.registerFileProtocol(DESKTOP_PET_PACK_SCHEME, (request, callback) => {
    try {
      const url = new URL(request.url);
      // 市场缩略图由 main 从固定 codexpet.top 源限长下载后缓存；renderer 只能引用 slug，
      // 不能把任意 preview URL 或路径传进协议。
      const marketPreviewMatch =
        url.hostname === "market-preview"
          ? /^\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})\/idle\.webp$/.exec(url.pathname)
          : null;
      if (marketPreviewMatch || (url.hostname === "market-preview" && url.pathname !== `/${DESKTOP_PET_SPRITESHEET_FILE}`)) {
        if (!marketPreviewMatch || !options.marketPreviewRootDir) {
          callback({ error: NET_ERR_FILE_NOT_FOUND });
          return;
        }
        const root = safeRealpath(options.marketPreviewRootDir);
        const target = safeRealpath(join(options.marketPreviewRootDir, `${marketPreviewMatch[1]}.webp`));
        if (!root || !target || !target.startsWith(root + sep)) {
          callback({ error: NET_ERR_FILE_NOT_FOUND });
          return;
        }
        callback(target);
        return;
      }
      // pets 根目录可能晚于协议安装时创建（首次启用时铺内置宠物），
      // realpath 必须按每次请求惰性解析：安装时缓存 null 会让所有请求永久 404。
      const normalizedRoot = safeRealpath(options.petsRootDir);
      if (!normalizedRoot) {
        callback({ error: NET_ERR_FILE_NOT_FOUND });
        return;
      }
      const petId = url.hostname;
      if (!DESKTOP_PET_ID_PATTERN.test(petId)) {
        callback({ error: NET_ERR_FILE_NOT_FOUND });
        return;
      }
      if (url.pathname !== `/${DESKTOP_PET_SPRITESHEET_FILE}`) {
        callback({ error: NET_ERR_FILE_NOT_FOUND });
        return;
      }
      const target = safeRealpath(join(options.petsRootDir, petId, DESKTOP_PET_SPRITESHEET_FILE));
      if (!target || !target.startsWith(normalizedRoot + sep)) {
        callback({ error: NET_ERR_FILE_NOT_FOUND });
        return;
      }
      callback(target);
    } catch {
      callback({ error: NET_ERR_FILE_NOT_FOUND });
    }
  });
}
