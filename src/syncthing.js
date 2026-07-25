import { setTimeout as sleep } from "node:timers/promises";

const VALID_ACTIONS = new Set(["update", "delete"]);
const VALID_TYPES = new Set(["file", "dir", "directory", "symlink"]);

function normalizeDeviceId(value) {
  return String(value || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

const CURSOR_SCHEMA_VERSION = 2;
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
    origins: { deviceIds: [] },
    lastEventId: 0,
    lastEventTime: null
  };
}

function getFolderState(state, folderId) {
  state.folders[folderId] ??= emptyFolderState();
  state.folders[folderId].received ??= emptyFolderState().received;
  state.folders[folderId].errors ??= emptyFolderState().errors;
  state.folders[folderId].origins ??= emptyFolderState().origins;
  return state.folders[folderId];
}

function resetFolderActivity(folder) {
  folder.received = emptyFolderState().received;
  folder.errors = emptyFolderState().errors;
  folder.origins = emptyFolderState().origins;
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

function addOrigin(folder, deviceId) {
  const normalized = normalizeDeviceId(deviceId);
  if (!normalized || folder.origins.deviceIds.includes(normalized)) return false;

  folder.origins.deviceIds.push(normalized);
  return true;
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
    this.deviceNamesByShortId = new Map();
    this.instanceId = "unknown";
    this.instanceName = "MiniPC";
    this.quietTimers = new Map();
    this.outboxRunning = false;
    this.outboxRetryTimer = null;
    this.mainConnected = false;
    this.diskConnected = false;
    this.state.outbox ??= [];
    this.state.notificationCooldowns ??= {};
  }

  getStatus() {
    return {
      syncthingConnected: this.mainConnected && this.diskConnected,
      mainEventStreamConnected: this.mainConnected,
      diskEventStreamConnected: this.diskConnected,
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
    this.deviceNamesByShortId.clear();
    this.instanceId = status.myID || "unknown";

    for (const folder of folders) {
      this.folderInfo.set(folder.id, {
        label: folder.label || folder.id
      });
    }

    for (const device of devices) {
      const normalizedId = normalizeDeviceId(device.deviceID);
      const displayName = device.name || device.deviceID;
      this.deviceNames.set(normalizedId, displayName);
      if (normalizedId) this.deviceNamesByShortId.set(normalizedId.slice(0, 7), displayName);
    }

    this.instanceName = this.deviceName(this.instanceId) || this.instanceId || "MiniPC";
  }

  deviceName(deviceId) {
    const normalized = normalizeDeviceId(deviceId);
    if (!normalized) return null;

    return (
      this.deviceNames.get(normalized) ||
      this.deviceNamesByShortId.get(normalized.slice(0, 7)) ||
      (normalized.length <= 7 ? normalized : String(deviceId))
    );
  }

  folderName(folderId) {
    return (
      this.config.folderNames[folderId] ||
      this.folderInfo.get(folderId)?.label ||
      folderId
    );
  }

  async initializeCursors() {
    const alreadyCurrent =
      this.state.cursorSchemaVersion === CURSOR_SCHEMA_VERSION &&
      this.state.initialized === true &&
      this.state.diskInitialized === true;

    if (alreadyCurrent) return;

    const wasInitialized = this.state.initialized === true;
    const [mainEvents, diskEvents] = await Promise.all([
      this.request(`/rest/events?since=0&limit=1&timeout=1&events=${MAIN_EVENTS}`),
      this.request("/rest/events/disk?since=0&limit=1&timeout=1")
    ]);

    this.state.lastMainEvent = mainEvents.at(-1)?.id || 0;
    this.state.lastDiskEvent = diskEvents.at(-1)?.id || 0;
    this.state.folders = {};
    this.state.initialized = true;
    this.state.diskInitialized = true;
    this.state.cursorSchemaVersion = CURSOR_SCHEMA_VERSION;
    await this.saveState(this.state);

    this.logger.info(wasInitialized ? "event_cursors_migrated" : "event_history_skipped", {
      cursorSchemaVersion: CURSOR_SCHEMA_VERSION,
      lastMainEvent: this.state.lastMainEvent,
      lastDiskEvent: this.state.lastDiskEvent
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

    const originDeviceIds = [...folder.origins.deviceIds];
    const originDeviceNames = [...new Set(
      originDeviceIds.map((deviceId) => this.deviceName(deviceId)).filter(Boolean)
    )];

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
      originDeviceIds,
      originDeviceNames,
      samplePath: folder.errors.samplePath,
      sampleError: folder.errors.sampleError
    };
  }

  cooldownCandidates(notification) {
    const ids = Array.isArray(notification.originDeviceIds)
      ? [...new Set(notification.originDeviceIds.map(normalizeDeviceId).filter(Boolean))]
      : [];

    if (ids.length > 0) {
      return ids.map((deviceId) => ({
        key: deviceId,
        deviceId,
        deviceName: this.deviceName(deviceId) || deviceId
      }));
    }

    const names = Array.isArray(notification.originDeviceNames)
      ? [...new Set(notification.originDeviceNames.map(String).filter(Boolean))]
      : [];

    if (names.length > 0) {
      return names.map((deviceName) => ({
        key: `name:${normalizeDeviceId(deviceName) || deviceName}`,
        deviceId: null,
        deviceName
      }));
    }

    return [{
      key: "unknown",
      deviceId: null,
      deviceName: "Dispositivo no identificado"
    }];
  }

  applySyncCooldown(notification) {
    if (notification.type !== "sync_completed" || this.config.syncCooldownMs <= 0) {
      return { notification, suppressed: false, suppressedOrigins: [] };
    }

    const now = Date.now();
    const eligible = [];
    const suppressed = [];

    for (const candidate of this.cooldownCandidates(notification)) {
      const cooldownKey = `${notification.folderId}\u0000${candidate.key}`;
      const lastQueuedAt = Number(this.state.notificationCooldowns[cooldownKey] || 0);

      if (lastQueuedAt > 0 && now - lastQueuedAt < this.config.syncCooldownMs) {
        suppressed.push({
          ...candidate,
          remainingMs: this.config.syncCooldownMs - (now - lastQueuedAt)
        });
        continue;
      }

      eligible.push({ ...candidate, cooldownKey });
    }

    if (eligible.length === 0) {
      return { notification, suppressed: true, suppressedOrigins: suppressed };
    }

    for (const candidate of eligible) {
      this.state.notificationCooldowns[candidate.cooldownKey] = now;
    }

    const cutoff = now - Math.max(this.config.syncCooldownMs * 10, 24 * 60 * 60 * 1000);
    for (const [key, timestamp] of Object.entries(this.state.notificationCooldowns)) {
      if (Number(timestamp) < cutoff) delete this.state.notificationCooldowns[key];
    }

    return {
      notification: {
        ...notification,
        originDeviceIds: eligible.map((candidate) => candidate.deviceId).filter(Boolean),
        originDeviceNames: [...new Set(eligible.map((candidate) => candidate.deviceName))]
      },
      suppressed: false,
      suppressedOrigins: suppressed
    };
  }

  async flushFolder(folderId) {
    if (this.shutdownSignal.aborted) return;

    const folder = getFolderState(this.state, folderId);
    if (!hasPendingActivity(folder)) return;

    let notification = this.buildNotification(folderId, folder);
    resetFolderActivity(folder);

    const cooldown = this.applySyncCooldown(notification);
    notification = cooldown.notification;

    if (cooldown.suppressed) {
      await this.saveState(this.state);
      this.logger.info("folder_update_suppressed_by_cooldown", {
        folderId,
        folderName: notification.folderName,
        cooldownMs: this.config.syncCooldownMs,
        origins: cooldown.suppressedOrigins.map((origin) => origin.deviceName),
        remainingMs: Math.max(...cooldown.suppressedOrigins.map((origin) => origin.remainingMs), 0)
      });
      return;
    }

    this.state.outbox.push(notification);
    await this.saveState(this.state);

    this.logger.info("folder_update_queued", {
      folderId,
      folderName: notification.folderName,
      type: notification.type,
      count: notification.count,
      errorCount: notification.errorCount,
      origins: notification.originDeviceNames,
      cooldownSuppressedOrigins: cooldown.suppressedOrigins.map((origin) => origin.deviceName)
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

  handleRemoteChangeDetected(event) {
    const data = event.data || {};
    const folderId = data.folder;
    if (!folderId || !data.modifiedBy) return;

    const folder = getFolderState(this.state, folderId);
    if (!addOrigin(folder, data.modifiedBy)) return;

    folder.lastEventId = event.id;
    folder.lastEventTime = event.time;

    this.logger.debug("remote_change_origin_detected", {
      folderId,
      deviceId: normalizeDeviceId(data.modifiedBy).slice(0, 7),
      deviceName: this.deviceName(data.modifiedBy),
      path: data.path || null
    });

    if (hasPendingActivity(folder) && ["idle", "error"].includes(folder.state)) {
      this.scheduleQuietFlush(folderId);
    }
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
        this.mainConnected = true;

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
        this.mainConnected = false;
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


  async pollDisk() {
    let reconnectAttempt = 0;

    while (!this.shutdownSignal.aborted) {
      try {
        const params = new URLSearchParams({
          since: String(this.state.lastDiskEvent),
          timeout: String(this.config.eventTimeoutSeconds)
        });

        const events = await this.request(`/rest/events/disk?${params}`);
        reconnectAttempt = 0;
        this.diskConnected = true;

        for (const event of events) {
          this.logger.debug("syncthing_disk_event", {
            id: event.id,
            type: event.type
          });

          if (event.type === "RemoteChangeDetected") {
            this.handleRemoteChangeDetected(event);
          }

          this.state.lastDiskEvent = event.id;
        }

        if (events.length > 0) await this.saveState(this.state);
      } catch (error) {
        if (this.shutdownSignal.aborted) break;
        this.diskConnected = false;
        const delay = jitteredBackoff(
          reconnectAttempt++,
          this.config.reconnectMinDelayMs,
          this.config.reconnectMaxDelayMs
        );
        this.logger.warn("syncthing_disk_stream_reconnecting", {
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
    this.mainConnected = true;
    this.diskConnected = true;

    this.logger.info("syncthing_connected", {
      instanceId: this.instanceId,
      instanceName: this.instanceName,
      folders: this.folderInfo.size,
      quietPeriodMs: this.config.quietPeriodMs,
      syncCooldownMs: this.config.syncCooldownMs,
      lastMainEvent: this.state.lastMainEvent,
      lastDiskEvent: this.state.lastDiskEvent
    });

    this.resumePendingFolders();
    void this.drainOutbox();
    await Promise.all([this.pollMain(), this.pollDisk()]);
  }

  async stop() {
    for (const folderId of this.quietTimers.keys()) this.cancelQuietTimer(folderId);
    if (this.outboxRetryTimer) clearTimeout(this.outboxRetryTimer);
    await this.saveState(this.state).catch(() => {});
  }
}
