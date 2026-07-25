import { setTimeout as sleep } from "node:timers/promises";

const VALID_ACTIONS = new Set(["update", "delete"]);
const VALID_TYPES = new Set(["file", "dir", "directory", "symlink"]);
const MAIN_EVENTS = "ItemFinished,StateChanged,ConfigSaved";

function emptyFolderState() {
  return {
    state: "idle",
    received: { changed: false, count: 0, seen: [] },
    errors: {
      changed: false,
      count: 0,
      samplePath: null,
      sampleError: null,
      seen: []
    },
    lastEventId: 0,
    lastEventTime: null
  };
}

function getFolderState(state, folderId) {
  state.folders[folderId] ??= emptyFolderState();
  state.folders[folderId].received ??= emptyFolderState().received;
  state.folders[folderId].errors ??= emptyFolderState().errors;
  return state.folders[folderId];
}

function resetFolderActivity(folder) {
  folder.received = emptyFolderState().received;
  folder.errors = emptyFolderState().errors;
  folder.lastEventId = 0;
  folder.lastEventTime = null;
}

function addReceived(folder, path) {
  const key = String(path || "(unknown)");
  if (folder.received.seen.includes(key)) return;

  folder.received.changed = true;
  folder.received.count += 1;
  folder.received.seen.push(key);
}

function addError(folder, error, path) {
  const pathKey = String(path || "(folder)");
  const errorText = String(error || "Folder entered error state");
  const key = `${pathKey}\u0000${errorText}`;
  if (folder.errors.seen.includes(key)) return;

  folder.errors.changed = true;
  folder.errors.count += 1;
  folder.errors.samplePath ??= path ? String(path) : null;
  folder.errors.sampleError ??= errorText;
  folder.errors.seen.push(key);
}

function hasPendingActivity(folder) {
  return folder.received.changed || folder.errors.changed;
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
    this.instanceName = "MiniPC";
    this.quietTimers = new Map();
    this.outboxRunning = false;
    this.outboxRetryTimer = null;
    this.connected = false;
    this.state.outbox ??= [];
  }

  getStatus() {
    return {
      syncthingConnected: this.connected,
      instanceId: this.instanceId,
      instanceName: this.instanceName,
      folders: this.folderInfo.size,
      pendingNotifications: this.state.outbox.length
    };
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

    this.folderInfo.clear();
    this.deviceNames.clear();
    this.instanceId = status.myID || "unknown";

    for (const folder of folders) {
      this.folderInfo.set(folder.id, {
        label: folder.label || folder.id
      });
    }

    for (const device of devices) {
      this.deviceNames.set(device.deviceID, device.name || device.deviceID);
    }

    this.instanceName = this.deviceNames.get(this.instanceId) || this.instanceId || "MiniPC";
  }

  folderName(folderId) {
    return (
      this.config.folderNames[folderId] ||
      this.folderInfo.get(folderId)?.label ||
      folderId
    );
  }

  async initializeCursor() {
    if (this.state.initialized) return;

    const events = await this.request(
      `/rest/events?since=0&limit=1&timeout=1&events=${MAIN_EVENTS}`
    );

    this.state.lastMainEvent = events.at(-1)?.id || 0;
    this.state.folders = {};
    this.state.initialized = true;
    await this.saveState(this.state);

    this.logger.info("event_history_skipped", {
      lastMainEvent: this.state.lastMainEvent
    });
  }

  cancelQuietTimer(folderId) {
    const timer = this.quietTimers.get(folderId);
    if (!timer) return;
    clearTimeout(timer);
    this.quietTimers.delete(folderId);
  }

  scheduleQuietFlush(folderId) {
    const folder = getFolderState(this.state, folderId);
    if (!hasPendingActivity(folder)) return;

    this.cancelQuietTimer(folderId);
    const timer = setTimeout(() => {
      this.quietTimers.delete(folderId);
      void this.flushFolder(folderId);
    }, this.config.quietPeriodMs);
    timer.unref?.();
    this.quietTimers.set(folderId, timer);

    this.logger.debug("folder_quiet_period_started", {
      folderId,
      delayMs: this.config.quietPeriodMs
    });
  }

  buildNotification(folderId, folder) {
    const isError = folder.errors.changed;
    const timestamp = folder.lastEventTime || new Date().toISOString();

    return {
      id: `syncthing:${this.instanceId}:${folderId}:${folder.lastEventId || Date.now()}`,
      type: isError ? "sync_error" : "sync_completed",
      folderId,
      folderName: this.folderName(folderId),
      instanceId: this.instanceId,
      instanceName: this.instanceName,
      timestamp,
      count: folder.received.count,
      errorCount: folder.errors.count,
      samplePath: folder.errors.samplePath,
      sampleError: folder.errors.sampleError
    };
  }

  async flushFolder(folderId) {
    if (this.shutdownSignal.aborted) return;

    const folder = getFolderState(this.state, folderId);
    if (!hasPendingActivity(folder)) return;

    const notification = this.buildNotification(folderId, folder);
    resetFolderActivity(folder);
    this.state.outbox.push(notification);
    await this.saveState(this.state);

    this.logger.info("folder_update_queued", {
      folderId,
      folderName: notification.folderName,
      type: notification.type,
      count: notification.count,
      errorCount: notification.errorCount
    });

    void this.drainOutbox();
  }

  scheduleOutboxRetry() {
    if (this.outboxRetryTimer || this.shutdownSignal.aborted) return;
    this.outboxRetryTimer = setTimeout(() => {
      this.outboxRetryTimer = null;
      void this.drainOutbox();
    }, this.config.outboxRetryDelayMs);
    this.outboxRetryTimer.unref?.();
  }

  async drainOutbox() {
    if (this.outboxRunning || this.shutdownSignal.aborted) return;
    this.outboxRunning = true;

    try {
      while (this.state.outbox.length > 0 && !this.shutdownSignal.aborted) {
        const notification = this.state.outbox[0];
        const result = await this.notifications.send(notification);

        if (!result.delivered) {
          this.logger.warn("outbox_delivery_deferred", {
            notificationId: notification.id,
            error: result.error || "delivery_failed"
          });
          this.scheduleOutboxRetry();
          break;
        }

        this.state.outbox.shift();
        await this.saveState(this.state);
      }
    } finally {
      this.outboxRunning = false;
    }
  }

  handleItemFinished(event) {
    const data = event.data || {};
    const folderId = data.folder;
    if (!folderId) return;

    const folder = getFolderState(this.state, folderId);

    if (data.error) {
      this.cancelQuietTimer(folderId);
      folder.lastEventId = event.id;
      folder.lastEventTime = event.time;
      addError(folder, data.error, data.item || null);
      return;
    }

    if (!VALID_ACTIONS.has(data.action) || !VALID_TYPES.has(data.type)) return;

    this.cancelQuietTimer(folderId);
    folder.lastEventId = event.id;
    folder.lastEventTime = event.time;
    addReceived(folder, data.item);
  }

  handleStateChanged(event) {
    const data = event.data || {};
    const folderId = data.folder;
    if (!folderId) return;

    const folder = getFolderState(this.state, folderId);
    folder.state = data.to || folder.state;
    folder.lastEventId = event.id;
    folder.lastEventTime = event.time;

    if (data.to !== "idle" && data.to !== "error") {
      this.cancelQuietTimer(folderId);
      return;
    }

    if (data.to === "error" && !folder.errors.changed) {
      addError(folder, "Folder entered error state", null);
    }

    this.scheduleQuietFlush(folderId);
  }

  async handleConfigSaved() {
    try {
      await this.loadMetadata();
      this.logger.info("syncthing_configuration_reloaded", {
        folders: this.folderInfo.size
      });
    } catch (error) {
      this.logger.warn("syncthing_configuration_reload_failed", {
        error: error.message
      });
    }
  }

  resumePendingFolders() {
    for (const [folderId, folder] of Object.entries(this.state.folders)) {
      if (hasPendingActivity(folder) && ["idle", "error"].includes(folder.state)) {
        this.scheduleQuietFlush(folderId);
      }
    }
  }

  async pollMain() {
    let reconnectAttempt = 0;

    while (!this.shutdownSignal.aborted) {
      try {
        const params = new URLSearchParams({
          since: String(this.state.lastMainEvent),
          timeout: String(this.config.eventTimeoutSeconds),
          events: MAIN_EVENTS
        });

        const events = await this.request(`/rest/events?${params}`);
        reconnectAttempt = 0;
        this.connected = true;

        for (const event of events) {
          this.logger.debug("syncthing_event", {
            id: event.id,
            type: event.type
          });

          if (event.type === "ItemFinished") this.handleItemFinished(event);
          else if (event.type === "StateChanged") this.handleStateChanged(event);
          else if (event.type === "ConfigSaved") await this.handleConfigSaved();

          this.state.lastMainEvent = event.id;
        }

        if (events.length > 0) await this.saveState(this.state);
      } catch (error) {
        if (this.shutdownSignal.aborted) break;
        this.connected = false;
        const delay = jitteredBackoff(
          reconnectAttempt++,
          this.config.reconnectMinDelayMs,
          this.config.reconnectMaxDelayMs
        );
        this.logger.warn("syncthing_reconnecting", {
          delayMs: delay,
          error: error.message
        });
        await sleep(delay, undefined, { signal: this.shutdownSignal }).catch(() => {});
      }
    }
  }

  async run() {
    await this.loadMetadata();
    await this.initializeCursor();
    this.connected = true;

    this.logger.info("syncthing_connected", {
      instanceId: this.instanceId,
      instanceName: this.instanceName,
      folders: this.folderInfo.size,
      quietPeriodMs: this.config.quietPeriodMs
    });

    this.resumePendingFolders();
    void this.drainOutbox();
    await this.pollMain();
  }

  async stop() {
    for (const folderId of this.quietTimers.keys()) this.cancelQuietTimer(folderId);
    if (this.outboxRetryTimer) clearTimeout(this.outboxRetryTimer);
    await this.saveState(this.state).catch(() => {});
  }
}
