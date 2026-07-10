const required = ["SYNCTHING_URL", "SYNCTHING_API_KEY", "NOTIFICATIONS_URL"];

function parseInteger(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;

  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseFolderNames() {
  const raw = process.env.FOLDER_NAMES_JSON?.trim();
  if (!raw) return {};

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("FOLDER_NAMES_JSON must be valid JSON");
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("FOLDER_NAMES_JSON must be a JSON object");
  }

  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [String(key), String(value)])
  );
}

for (const name of required) {
  if (!process.env[name]?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

const direction = (process.env.SYNC_DIRECTION || "both").toLowerCase();
if (!["received", "local", "both"].includes(direction)) {
  throw new Error("SYNC_DIRECTION must be received, local, or both");
}

const logLevel = (process.env.LOG_LEVEL || "info").toLowerCase();
if (!["debug", "info", "warn", "error", "silent"].includes(logLevel)) {
  throw new Error("LOG_LEVEL must be debug, info, warn, error, or silent");
}

export const config = Object.freeze({
  syncthingUrl: process.env.SYNCTHING_URL.replace(/\/+$/, ""),
  syncthingApiKey: process.env.SYNCTHING_API_KEY,
  notificationsUrl: process.env.NOTIFICATIONS_URL,
  stateFile: process.env.STATE_FILE || "/data/state.json",
  folderNames: parseFolderNames(),
  direction,
  logLevel,
  eventTimeoutSeconds: parseInteger("EVENT_TIMEOUT_SECONDS", 60, { min: 10, max: 300 }),
  reconnectMinDelayMs: parseInteger("RECONNECT_MIN_DELAY_MS", 1000, { min: 100, max: 60000 }),
  reconnectMaxDelayMs: parseInteger("RECONNECT_MAX_DELAY_MS", 30000, { min: 1000, max: 300000 }),
  notificationTimeoutMs: parseInteger("NOTIFICATION_TIMEOUT_MS", 10000, { min: 1000, max: 120000 }),
  deduplicationWindowSeconds: parseInteger("DEDUPLICATION_WINDOW_SECONDS", 60, { min: 0, max: 3600 }),
  notificationAttempts: 5,
  notificationRetryDelayMs: 5 * 60 * 1000
});
