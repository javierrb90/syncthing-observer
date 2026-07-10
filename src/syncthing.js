import { isAbsolute, relative, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const VALID_ACTIONS = new Set(["update", "delete"]);
const VALID_TYPES = new Set(["file", "dir", "directory", "symlink"]);

function emptyFolderState() {
  return {
    state: "idle",
    received: { changed: false, count: 0, samplePath: null, seen: [] },
    local: { changed: false, count: 0, samplePath: null, seen: [] }
  };
}

function getFolderState(state, folderId) {
  state.folders[folderId] ??= emptyFolderState();
  state.folders[folderId].received ??= emptyFolderState().received;
  state.folders[folderId].local ??= emptyFolderState().local;
  return state.folders[folderId];
}

function resetChange(change) {
  change.changed = false;
  change.count = 0;
  change.samplePath = null;
  change.seen = [];
}

function addChange(change, path) {
  const key = String(path || "(unknown)");
  if (change.seen.includes(key)) return;

  change.changed = true;
  change.count += 1;
  change.samplePath ??= key;
  change.seen.push(key);
}

function normalizeRelativePath(rawPath, folderPath) {
  if (!rawPath) return "(unknown)";
  const value = String(rawPath);

  if (folderPath && isAbsolute(value) && isAbsolute(folderPath)) {
    const result = relative(folderPath, value);
    if (result && !result.startsWith(`..${sep}`) && result !== "..") {
      return result;
    }
  }

  return value;
}

function jitteredBackoff(attempt, min, max) {
  const base = Math.min(max, min * (2 ** Math.min(attempt, 10)));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

export class SyncthingMonitor {
  constructor({ config, logger, state, saveState, notifications, shutdownSignal }) {
    this.config = config;
    this.logger = logger;
    this.state = state;
    this.saveState = saveState;
    this.notifications = notifications;
    this.shutdownSignal = shutdownSignal;
    this.folderInfo = new Map();
    this.deviceNames = new Map();
    this.instanceId = "unknown";
    this.instanceName = "Syncthing";
    this.pendingNotifications = new Set();
    this.state.recentNotifications ??= {};
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.config.syncthingUrl}${path}`, {
      ...options,
      headers: {
        "X-API-Key": this.config.syncthingApiKey,
        "accept": "application/json",
        ...(options.headers || {})
      },
      signal: options.signal || this.shutdownSignal
    });

    if (!response.ok) {
      throw new Error(`Syncthing returned HTTP ${response.status} for ${path}`);
    }
    return response.json();
  }

  async loadMetadata() {
    const [status, folders, devices] = await Promise.all([
      this.request("/rest/system/status"),
      this.request("/rest/config/folders"),
      this.request("/rest/config/devices")
    ]);

    this.instanceId = status.myID || "unknown";

    for (const folder of folders) {
      this.folderInfo.set(folder.id, {
        label: folder.label || folder.id,
        path: folder.path || null
      });
    }

    for (const device of devices) {
      this.deviceNames.set(device.deviceID, device.name || device.deviceID);
    }

    this.instanceName = this.deviceNames.get(this.instanceId) || this.instanceId;
  }

  folderName(folderId, eventLabel) {
    return (
      this.config.folderNames[folderId] ||
      eventLabel ||
      this.folderInfo.get(folderId)?.label ||
      folderId
    );
  }

  async initializeCursors() {
    if (this.state.initialized) return;

    const [mainEvents, diskEvents] = await Promise.all([
      this.request("/rest/events?since=0&limit=1&timeout=1&events=ItemFinished,StateChanged"),
      this.request("/rest/events/disk?since=0&limit=1&timeout=1")
    ]);

    this.state.lastMainEvent = mainEvents.at(-1)?.id || 0;
    this.state.lastDiskEvent = diskEvents.at(-1)?.id || 0;
    this.state.folders = {};
    this.state.initialized = true;
    await this.saveState(this.state);

    this.logger.info("event_history_skipped", {
      lastMainEvent: this.state.lastMainEvent,
      lastDiskEvent: this.state.lastDiskEvent
    });
  }

  queueNotification(payload) {
    const task = this.notifications.send(payload).finally(() => {
      this.pendingNotifications.delete(task);
    });
    this.pendingNotifications.add(task);
  }

  getLogicalExternalId(folderId, direction, event) {
    const base = `syncthing:${this.instanceId}:${folderId}:${direction}`;
    const windowMs = this.config.deduplicationWindowSeconds * 1000;
    const eventTime = Date.parse(event.time);
    const now = Number.isFinite(eventTime) ? eventTime : Date.now();
    const previous = this.state.recentNotifications[base];

    if (
      windowMs > 0 &&
      previous &&
      typeof previous.externalId === "string" &&
      Number.isFinite(previous.timestamp) &&
      now - previous.timestamp >= 0 &&
      now - previous.timestamp <= windowMs
    ) {
      previous.timestamp = now;
      return previous.externalId;
    }

    const externalId = `${base}:${event.id}`;
    this.state.recentNotifications[base] = {
      externalId,
      timestamp: now
    };

    const cutoff = now - Math.max(windowMs * 2, 60 * 60 * 1000);
    for (const [key, value] of Object.entries(this.state.recentNotifications)) {
      if (!value || !Number.isFinite(value.timestamp) || value.timestamp < cutoff) {
        delete this.state.recentNotifications[key];
      }
    }

    return externalId;
  }

  buildCompletedPayload(folderId, event, received, local) {
    const direction =
      received.changed && local.changed ? "both" :
      received.changed ? "received" :
      "local";

    const count = received.count + local.count;
    const samplePath = received.samplePath || local.samplePath;
    const folderName = this.folderName(folderId);

    return {
      source: "syncthing",
      type: "sync_completed",
      priority: "normal",
      title: folderName,
      subtitle: direction === "received"
        ? "Synchronization received"
        : direction === "local"
          ? "Local changes detected"
          : "Local and received changes detected",
      externalId: this.getLogicalExternalId(folderId, direction, event),
      meta: {
        folderId,
        folderName,
        timestamp: event.time,
        count,
        files: samplePath ? [samplePath] : [],
        direction,
        instanceId: this.instanceId,
        instanceName: this.instanceName
      }
    };
  }

  buildErrorPayload(folderId, event, error, path = null) {
    const folderName = this.folderName(folderId);
    const externalId = `syncthing:${this.instanceId}:${folderId}:error:${event.id}`;

    return {
      source: "syncthing",
      type: "sync_error",
      priority: "high",
      title: folderName,
      subtitle: "Synchronization error",
      externalId,
      meta: {
        folderId,
        folderName,
        timestamp: event.time,
        instanceId: this.instanceId,
        instanceName: this.instanceName,
        deviceId: this.instanceId,
        deviceName: this.instanceName,
        error: error || "Folder entered error state",
        ...(path ? { path } : {})
      }
    };
  }

  handleItemFinished(event) {
    const data = event.data || {};
    const folderId = data.folder;
    if (!folderId) return;

    if (data.error) {
      this.queueNotification(
        this.buildErrorPayload(folderId, event, String(data.error), data.item || null)
      );
      return;
    }

    if (!VALID_ACTIONS.has(data.action) || !VALID_TYPES.has(data.type)) return;
    if (!["received", "both"].includes(this.config.direction)) return;

    const folder = getFolderState(this.state, folderId);
    addChange(folder.received, data.item);
  }

  handleStateChanged(event) {
    const data = event.data || {};
    const folderId = data.folder;
    if (!folderId) return;

    const folder = getFolderState(this.state, folderId);
    folder.state = data.to || folder.state;

    if (data.to === "error") {
      this.queueNotification(this.buildErrorPayload(folderId, event));
      resetChange(folder.received);
      resetChange(folder.local);
      return;
    }

    if (data.to !== "idle") return;

    const received = folder.received;
    const local = folder.local;

    if (received.changed || local.changed) {
      this.queueNotification(
        this.buildCompletedPayload(folderId, event, received, local)
      );
    }

    resetChange(received);
    resetChange(local);
  }

  handleDiskEvent(event) {
    if (event.type !== "LocalChangeDetected") return;
    if (!["local", "both"].includes(this.config.direction)) return;

    const data = event.data || {};
    const folderId = data.folderID || data.folder;
    if (!folderId || !VALID_ACTIONS.has(data.action) || !VALID_TYPES.has(data.type)) return;

    const folder = getFolderState(this.state, folderId);
    const folderPath = this.folderInfo.get(folderId)?.path;
    const relativePath = normalizeRelativePath(data.path, folderPath);
    addChange(folder.local, relativePath);
  }

  async pollMain() {
    let reconnectAttempt = 0;

    while (!this.shutdownSignal.aborted) {
      try {
        const params = new URLSearchParams({
          since: String(this.state.lastMainEvent),
          timeout: String(this.config.eventTimeoutSeconds),
          events: "ItemFinished,StateChanged"
        });

        const events = await this.request(`/rest/events?${params}`);
        reconnectAttempt = 0;

        for (const event of events) {
          this.logger.debug("syncthing_event", {
            stream: "main",
            id: event.id,
            type: event.type
          });

          if (event.type === "ItemFinished") this.handleItemFinished(event);
          else if (event.type === "StateChanged") this.handleStateChanged(event);

          this.state.lastMainEvent = event.id;
        }

        if (events.length > 0) await this.saveState(this.state);
      } catch (error) {
        if (this.shutdownSignal.aborted) break;
        const delay = jitteredBackoff(
          reconnectAttempt++,
          this.config.reconnectMinDelayMs,
          this.config.reconnectMaxDelayMs
        );
        this.logger.warn("syncthing_reconnecting", {
          stream: "main",
          delayMs: delay,
          error: error.message
        });
        await sleep(delay, undefined, { signal: this.shutdownSignal }).catch(() => {});
      }
    }
  }

  async pollDisk() {
    if (!["local", "both"].includes(this.config.direction)) return;

    let reconnectAttempt = 0;

    while (!this.shutdownSignal.aborted) {
      try {
        const params = new URLSearchParams({
          since: String(this.state.lastDiskEvent),
          timeout: String(this.config.eventTimeoutSeconds)
        });

        const events = await this.request(`/rest/events/disk?${params}`);
        reconnectAttempt = 0;

        for (const event of events) {
          this.logger.debug("syncthing_event", {
            stream: "disk",
            id: event.id,
            type: event.type
          });

          this.handleDiskEvent(event);
          this.state.lastDiskEvent = event.id;
        }

        if (events.length > 0) await this.saveState(this.state);
      } catch (error) {
        if (this.shutdownSignal.aborted) break;
        const delay = jitteredBackoff(
          reconnectAttempt++,
          this.config.reconnectMinDelayMs,
          this.config.reconnectMaxDelayMs
        );
        this.logger.warn("syncthing_reconnecting", {
          stream: "disk",
          delayMs: delay,
          error: error.message
        });
        await sleep(delay, undefined, { signal: this.shutdownSignal }).catch(() => {});
      }
    }
  }

  async run() {
    await this.loadMetadata();
    await this.initializeCursors();

    this.logger.info("syncthing_connected", {
      instanceId: this.instanceId,
      instanceName: this.instanceName,
      direction: this.config.direction,
      folders: this.folderInfo.size
    });

    await Promise.all([this.pollMain(), this.pollDisk()]);
  }

  async stop() {
    await this.saveState(this.state).catch(() => {});
  }
}
