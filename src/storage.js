import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const EMPTY_STATE = Object.freeze({
  initialized: false,
  lastMainEvent: 0,
  lastDiskEvent: 0,
  folders: {},
  recentNotifications: {}
});

export async function loadState(file, logger) {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);

    return {
      initialized: parsed.initialized === true,
      lastMainEvent: Number.isInteger(parsed.lastMainEvent) ? parsed.lastMainEvent : 0,
      lastDiskEvent: Number.isInteger(parsed.lastDiskEvent) ? parsed.lastDiskEvent : 0,
      folders: parsed.folders && typeof parsed.folders === "object" ? parsed.folders : {},
      recentNotifications:
        parsed.recentNotifications && typeof parsed.recentNotifications === "object"
          ? parsed.recentNotifications
          : {}
    };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      logger.warn("state_load_failed", { error: error.message });
    }
    return structuredClone(EMPTY_STATE);
  }
}

export function createStateWriter(file, logger) {
  let chain = Promise.resolve();

  return function saveState(state) {
    const snapshot = JSON.stringify(state, null, 2) + "\n";

    chain = chain
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        const tempFile = `${file}.tmp`;
        await writeFile(tempFile, snapshot, "utf8");
        await rename(tempFile, file);
      })
      .catch((error) => {
        logger.error("state_save_failed", { error: error.message });
        throw error;
      });

    return chain;
  };
}
