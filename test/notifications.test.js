import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { once } from "node:events";
import { buildPushoverMessage, createNotificationClient } from "../src/notifications.js";

const silentLogger = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {}
});

function baseConfig(overrides = {}) {
  return {
    pushoverApiUrl: "http://127.0.0.1:1/messages.json",
    pushoverAppToken: "app-token",
    pushoverUserKey: "user-key",
    pushoverDevice: null,
    pushoverSound: null,
    pushoverErrorSound: null,
    notificationTimeoutMs: 1000,
    notificationAttempts: 1,
    notificationRetryDelayMs: 1,
    ...overrides
  };
}

test("normal notifications contain folder and count but no filename", () => {
  const payload = buildPushoverMessage({
    type: "sync_completed",
    folderName: "(Saves) PCSX2 (PS2)",
    instanceName: "MiniPC",
    count: 20,
    originDeviceNames: ["Consola A"],
    samplePath: "secret-file.ps2",
    timestamp: "2026-07-25T12:00:00Z"
  }, baseConfig());

  assert.equal(payload.title, "Syncthing · (Saves) PCSX2 (PS2)");
  assert.match(payload.message, /20 elementos sincronizados/);
  assert.match(payload.message, /Origen: Consola A\./);
  assert.doesNotMatch(payload.message, /secret-file/);
  assert.equal(payload.priority, 0);
  assert.equal(payload.timestamp, 1784980800);
});

test("error notifications use high priority and include one diagnostic sample", () => {
  const payload = buildPushoverMessage({
    type: "sync_error",
    folderName: "Screenshots",
    instanceName: "MiniPC",
    count: 9,
    errorCount: 1,
    originDeviceNames: ["Consola B"],
    samplePath: "photo.png",
    sampleError: "permission denied"
  }, baseConfig({ pushoverErrorSound: "siren" }));

  assert.equal(payload.priority, 1);
  assert.equal(payload.sound, "siren");
  assert.match(payload.message, /9 elementos sincronizados/);
  assert.match(payload.message, /1 error detectado/);
  assert.match(payload.message, /Origen: Consola B\./);
  assert.match(payload.message, /photo\.png/);
  assert.match(payload.message, /permission denied/);
});

test("Pushover client validates the JSON status field", async (t) => {
  let receivedBody;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: 1, request: "request-id" }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const { port } = server.address();
  const controller = new AbortController();
  const client = createNotificationClient(
    baseConfig({ pushoverApiUrl: `http://127.0.0.1:${port}/messages.json` }),
    silentLogger,
    controller.signal
  );

  const result = await client.send({
    id: "test-1",
    type: "test",
    instanceName: "MiniPC"
  });

  assert.equal(result.delivered, true);
  assert.equal(result.requestId, "request-id");
  assert.equal(receivedBody.token, "app-token");
  assert.equal(receivedBody.user, "user-key");
});


test("successful notifications explicitly report an unknown origin when Syncthing provides none", () => {
  const payload = buildPushoverMessage({
    type: "sync_completed",
    folderName: "Screenshots",
    instanceName: "MiniPC",
    count: 1,
    originDeviceNames: []
  }, baseConfig());

  assert.match(payload.message, /Origen: no identificado\./);
});
