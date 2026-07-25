const required = [
  "SYNCTHING_URL",
  "SYNCTHING_API_KEY",
  "PUSHOVER_APP_TOKEN",
  "PUSHOVER_USER_KEY",
  "TEST_API_TOKEN"
];

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

for (const name of ["PUSHOVER_APP_TOKEN", "PUSHOVER_USER_KEY"]) {
  if (process.env[name].trim().startsWith("replace-with-")) {
    throw new Error(`${name} still contains its placeholder value`);
  }
}

if (process.env.TEST_API_TOKEN.trim().length < 16) {
  throw new Error("TEST_API_TOKEN must contain at least 16 characters");
}

const logLevel = (process.env.LOG_LEVEL || "info").toLowerCase();
if (!["debug", "info", "warn", "error", "silent"].includes(logLevel)) {
  throw new Error("LOG_LEVEL must be debug, info, warn, error, or silent");
}

export const config = Object.freeze({
  syncthingUrl: process.env.SYNCTHING_URL.replace(/\/+$/, ""),
  syncthingApiKey: process.env.SYNCTHING_API_KEY,
  stateFile: process.env.STATE_FILE || "/data/state.json",
  folderNames: parseFolderNames(),
  logLevel,
  eventTimeoutSeconds: parseInteger("EVENT_TIMEOUT_SECONDS", 60, { min: 10, max: 300 }),
  reconnectMinDelayMs: parseInteger("RECONNECT_MIN_DELAY_MS", 1000, { min: 100, max: 60000 }),
  reconnectMaxDelayMs: parseInteger("RECONNECT_MAX_DELAY_MS", 30000, { min: 1000, max: 300000 }),
  quietPeriodMs: parseInteger("QUIET_PERIOD_SECONDS", 10, { min: 0, max: 300 }) * 1000,

  pushoverApiUrl: (process.env.PUSHOVER_API_URL || "https://api.pushover.net/1/messages.json").trim(),
  pushoverAppToken: process.env.PUSHOVER_APP_TOKEN.trim(),
  pushoverUserKey: process.env.PUSHOVER_USER_KEY.trim(),
  pushoverDevice: process.env.PUSHOVER_DEVICE?.trim() || null,
  pushoverSound: process.env.PUSHOVER_SOUND?.trim() || null,
  pushoverErrorSound: process.env.PUSHOVER_ERROR_SOUND?.trim() || null,
  notificationTimeoutMs: parseInteger("NOTIFICATION_TIMEOUT_MS", 10000, { min: 1000, max: 120000 }),
  notificationAttempts: parseInteger("NOTIFICATION_ATTEMPTS", 5, { min: 1, max: 10 }),
  notificationRetryDelayMs:
    parseInteger("NOTIFICATION_RETRY_DELAY_SECONDS", 60, { min: 1, max: 3600 }) * 1000,
  outboxRetryDelayMs:
    parseInteger("OUTBOX_RETRY_DELAY_SECONDS", 300, { min: 10, max: 86400 }) * 1000,

  httpHost: process.env.HTTP_HOST?.trim() || "0.0.0.0",
  httpPort: parseInteger("HTTP_PORT", 8787, { min: 1, max: 65535 }),
  testApiToken: process.env.TEST_API_TOKEN.trim()
});
