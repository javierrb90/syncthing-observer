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
  return { monitor, state, shutdownController };
}

test("multiple received items become one notification after the folder stays idle", async () => {
  const sent = [];
  const { monitor } = makeMonitor(sent);

  monitor.handleItemFinished({
    id: 1,
    time: "2026-07-25T12:00:00Z",
    data: { folder: "pcsx2", item: "a.ps2", action: "update", type: "file", error: null }
  });
  monitor.handleItemFinished({
    id: 2,
    time: "2026-07-25T12:00:01Z",
    data: { folder: "pcsx2", item: "b.ps2", action: "update", type: "file", error: null }
  });
  monitor.handleStateChanged({
    id: 3,
    time: "2026-07-25T12:00:02Z",
    data: { folder: "pcsx2", from: "syncing", to: "idle" }
  });

  await sleep(60);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "sync_completed");
  assert.equal(sent[0].count, 2);
  assert.equal(sent[0].folderName, "(Saves) PCSX2 (PS2)");
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
