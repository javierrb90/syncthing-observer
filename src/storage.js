import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const EMPTY_STATE = Object.freeze({
  cursorSchemaVersion: 0,
  initialized: false,
  diskInitialized: false,
  lastMainEvent: 0,
  lastDiskEvent: 0,
  folders: {},
  outbox: []
});

function normalizeFolders(folders) {
  if (!folders || typeof folders !== "object" || Array.isArray(folders)) return {};

  return Object.fromEntries(
    Object.entries(folders).map(([folderId, folder]) => [
      folderId,
      {
        state: typeof folder?.state === "string" ? folder.state : "idle",
        received: {
          changed: folder?.received?.changed === true,
          count: Number.isInteger(folder?.received?.count) ? folder.received.count : 0,
          seen: Array.isArray(folder?.received?.seen) ? folder.received.seen.map(String) : []
        },
        errors: {
          changed: folder?.errors?.changed === true,
          count: Number.isInteger(folder?.errors?.count) ? folder.errors.count : 0,
          samplePath: folder?.errors?.samplePath ? String(folder.errors.samplePath) : null,
          sampleError: folder?.errors?.sampleError ? String(folder.errors.sampleError) : null,
          seen: Array.isArray(folder?.errors?.seen) ? folder.errors.seen.map(String) : []
        },
        origins: {
          deviceIds: Array.isArray(folder?.origins?.deviceIds)
            ? [...new Set(folder.origins.deviceIds.map((value) =>
                String(value).replace(/[^A-Z0-9]/gi, "").toUpperCase()
              ).filter(Boolean))]
            : []
        },
        lastEventId: Number.isInteger(folder?.lastEventId) ? folder.lastEventId : 0,
        lastEventTime: typeof folder?.lastEventTime === "string" ? folder.lastEventTime : null
      }
    ])
  );
}

export async function loadState(file, logger) {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);

    return {
      cursorSchemaVersion: Number.isInteger(parsed.cursorSchemaVersion)
        ? parsed.cursorSchemaVersion
        : 0,
      initialized: parsed.initialized === true,
      diskInitialized: parsed.diskInitialized === true,
      lastMainEvent: Number.isInteger(parsed.lastMainEvent) ? parsed.lastMainEvent : 0,
      lastDiskEvent: Number.isInteger(parsed.lastDiskEvent) ? parsed.lastDiskEvent : 0,
      folders: normalizeFolders(parsed.folders),
      outbox: Array.isArray(parsed.outbox)
        ? parsed.outbox.filter((entry) => entry && typeof entry === "object")
        : []
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
