import assert from "node:assert/strict";
import test from "node:test";
import { createControlServer } from "../src/server.js";

const silentLogger = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {}
});

test("protected curl endpoint sends a fixed Pushover test notification", async (t) => {
  const sent = [];
  const server = createControlServer({
    config: {
      httpHost: "127.0.0.1",
      httpPort: 0,
      testApiToken: "0123456789abcdef"
    },
    logger: silentLogger,
    notifications: {
      async send(notification) {
        sent.push(notification);
        return { delivered: true, requestId: "request-id" };
      }
    },
    getStatus: () => ({
      syncthingConnected: true,
      instanceName: "MiniPC",
      folders: 20,
      pendingNotifications: 0
    })
  });

  await server.start();
  t.after(() => server.stop());
  const { port } = server.address();

  const unauthorized = await fetch(`http://127.0.0.1:${port}/test-notification`, {
    method: "POST"
  });
  assert.equal(unauthorized.status, 401);

  const response = await fetch(`http://127.0.0.1:${port}/test-notification`, {
    method: "POST",
    headers: { authorization: "Bearer 0123456789abcdef" }
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.requestId, "request-id");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "test");
  assert.equal(sent[0].instanceName, "MiniPC");
});
