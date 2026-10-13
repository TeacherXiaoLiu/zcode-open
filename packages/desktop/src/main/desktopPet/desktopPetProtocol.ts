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
  options: { petsRootDir: string },
): void {
  const normalizedRoot = safeRealpath(options.petsRootDir);
  protocol.registerFileProtocol(DESKTOP_PET_PACK_SCHEME, (request, callback) => {
    try {
      const url = new URL(request.url);
      const petId = url.hostname;
      if (!DESKTOP_PET_ID_PATTERN.test(petId)) {
        callback({ error: NET_ERR_FILE_NOT_FOUND });
        return;
      }
      if (url.pathname !== `/${DESKTOP_PET_SPRITESHEET_FILE}`) {
        callback({ error: NET_ERR_FILE_NOT_FOUND });
        return;
      }
      const target = safeRealpath(
        join(options.petsRootDir, petId, DESKTOP_PET_SPRITESHEET_FILE),
      );
      if (!target || !normalizedRoot || !target.startsWith(normalizedRoot + sep)) {
        callback({ error: NET_ERR_FILE_NOT_FOUND });
        return;
      }
      callback(target);
    } catch {
      callback({ error: NET_ERR_FILE_NOT_FOUND });
    }
  });
}