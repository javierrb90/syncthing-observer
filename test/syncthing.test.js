import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { SyncthingMonitor } from "../src/syncthing.js";

const silentLogger = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {}
});

function makeMonitor(sent) {
  const state = {
    initialized: true,
    lastMainEvent: 0,
    folders: {},
    outbox: []
  };
  const shutdownController = new AbortController();

  const monitor = new SyncthingMonitor({
    config: {
      folderNames: {},
      quietPeriodMs: 20,
      outboxRetryDelayMs: 1000,
      syncthingUrl: "http://127.0.0.1:1",
      syncthingApiKey: "key",
      eventTimeoutSeconds: 60,
      reconnectMinDelayMs: 1,
      reconnectMaxDelayMs: 2
    },
    logger: silentLogger,
    state,
    saveState: async () => {},
    notifications: {
      async send(notification) {
        sent.push(notification);
        return { delivered: true, requestId: "test" };
      }
    },
    shutdownSignal: shutdownController.signal
  });

  monitor.instanceId = "MINIPC-ID";
  monitor.instanceName = "MiniPC";
  monitor.folderInfo.set("pcsx2", { label: "(Saves) PCSX2 (PS2)" });
  monitor.deviceNamesByShortId.set("AAAAAAA", "Consola A");
  monitor.deviceNamesByShortId.set("BBBBBBB", "Consola B");
  return { monitor, state, shutdownController };
}

test("multiple received items become one notification after the folder stays idle", async () => {
  const sent = [];
  const { monitor } = makeMonitor(sent);

  monitor.handleRemoteChangeDetected({
    id: 1,
    time: "2026-07-25T11:59:59Z",
    data: {
      folder: "pcsx2",
      path: "a.ps2",
      action: "modified",
      type: "file",
      modifiedBy: "AAAAAAA"
    }
  });
  monitor.handleItemFinished({
    id: 2,
    time: "2026-07-25T12:00:00Z",
    data: { folder: "pcsx2", item: "a.ps2", action: "update", type: "file", error: null }
  });
  monitor.handleItemFinished({
    id: 3,
    time: "2026-07-25T12:00:01Z",
    data: { folder: "pcsx2", item: "b.ps2", action: "update", type: "file", error: null }
  });
  monitor.handleStateChanged({
    id: 4,
    time: "2026-07-25T12:00:02Z",
    data: { folder: "pcsx2", from: "syncing", to: "idle" }
  });

  await sleep(60);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "sync_completed");
  assert.equal(sent[0].count, 2);
  assert.equal(sent[0].folderName, "(Saves) PCSX2 (PS2)");
  assert.deepEqual(sent[0].originDeviceNames, ["Consola A"]);
  assert.deepEqual(sent[0].originDeviceIds, ["AAAAAAA"]);
});

test("new activity during the quiet period postpones and aggregates the notification", async () => {
  const sent = [];
  const { monitor } = makeMonitor(sent);

  monitor.handleItemFinished({
    id: 1,
    time: "2026-07-25T12:00:00Z",
    data: { folder: "pcsx2", item: "a.ps2", action: "update", type: "file", error: null }
  });
  monitor.handleStateChanged({
    id: 2,
    time: "2026-07-25T12:00:01Z",
    data: { folder: "pcsx2", from: "syncing", to: "idle" }
  });

  await sleep(10);

  monitor.handleItemFinished({
    id: 3,
    time: "2026-07-25T12:00:02Z",
    data: { folder: "pcsx2", item: "b.ps2", action: "update", type: "file", error: null }
  });
  monitor.handleStateChanged({
    id: 4,
    time: "2026-07-25T12:00:03Z",
    data: { folder: "pcsx2", from: "syncing", to: "idle" }
  });

  await sleep(60);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].count, 2);
});


test("multiple origin devices are deduplicated and resolved from Syncthing names", async () => {
  const sent = [];
  const { monitor } = makeMonitor(sent);

  monitor.handleItemFinished({
    id: 1,
    time: "2026-07-25T12:00:00Z",
    data: { folder: "pcsx2", item: "a.ps2", action: "update", type: "file", error: null }
  });
  monitor.handleRemoteChangeDetected({
    id: 2,
    time: "2026-07-25T12:00:01Z",
    data: { folder: "pcsx2", path: "a.ps2", modifiedBy: "AAAAAAA" }
  });
  monitor.handleRemoteChangeDetected({
    id: 3,
    time: "2026-07-25T12:00:02Z",
    data: { folder: "pcsx2", path: "b.ps2", modifiedBy: "BBBBBBB" }
  });
  monitor.handleRemoteChangeDetected({
    id: 4,
    time: "2026-07-25T12:00:03Z",
    data: { folder: "pcsx2", path: "c.ps2", modifiedBy: "AAAAAAA" }
  });
  monitor.handleStateChanged({
    id: 5,
    time: "2026-07-25T12:00:04Z",
    data: { folder: "pcsx2", from: "syncing", to: "idle" }
  });

  await sleep(60);

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].originDeviceNames, ["Consola A", "Consola B"]);
  assert.deepEqual(sent[0].originDeviceIds, ["AAAAAAA", "BBBBBBB"]);
});

test("cursor migration keeps main and disk event streams separate", async () => {
  const sent = [];
  const { monitor, state } = makeMonitor(sent);
  const requested = [];

  state.initialized = true;
  state.lastMainEvent = 999;
  delete state.cursorSchemaVersion;
  delete state.diskInitialized;
  delete state.lastDiskEvent;

  monitor.request = async (path) => {
    requested.push(path);
    if (path.startsWith("/rest/events?")) return [{ id: 42 }];
    if (path.startsWith("/rest/events/disk?")) return [{ id: 84 }];
    throw new Error(`Unexpected request: ${path}`);
  };

  await monitor.initializeCursors();

  assert.equal(requested.length, 2);
  assert.match(requested[0], /events=ItemFinished,StateChanged,ConfigSaved/);
  assert.doesNotMatch(requested[0], /RemoteChangeDetected/);
  assert.equal(requested[1], "/rest/events/disk?since=0&limit=1&timeout=1");
  assert.equal(state.cursorSchemaVersion, 2);
  assert.equal(state.lastMainEvent, 42);
  assert.equal(state.lastDiskEvent, 84);
  assert.equal(state.initialized, true);
  assert.equal(state.diskInitialized, true);
});
