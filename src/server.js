import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function tokenMatches(actual, expected) {
  const actualBuffer = Buffer.from(actual || "", "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function extractToken(request) {
  const authorization = request.headers.authorization || "";
  if (authorization.startsWith("Bearer ")) return authorization.slice(7).trim();
  return String(request.headers["x-test-token"] || "").trim();
}

export function createControlServer({ config, logger, notifications, getStatus }) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, ...getStatus() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/test-notification") {
      if (!tokenMatches(extractToken(request), config.testApiToken)) {
        sendJson(response, 401, { ok: false, error: "unauthorized" });
        return;
      }

      const status = getStatus();
      const result = await notifications.send({
        id: `test:${Date.now()}`,
        type: "test",
        instanceName: status.instanceName || "MiniPC",
        timestamp: new Date().toISOString()
      });

      if (result.delivered) {
        sendJson(response, 200, {
          ok: true,
          message: "Pushover test notification sent",
          requestId: result.requestId || null
        });
      } else {
        sendJson(response, 502, {
          ok: false,
          error: result.error || "Pushover rejected the notification",
          status: result.status || null,
          requestId: result.requestId || null
        });
      }
      return;
    }

    sendJson(response, 404, { ok: false, error: "not_found" });
  });

  server.on("clientError", (error, socket) => {
    logger.warn("http_client_error", { error: error.message });
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  return Object.freeze({
    start() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.httpPort, config.httpHost, () => {
          server.removeListener("error", reject);
          const address = server.address();
          logger.info("http_server_started", {
            host: config.httpHost,
            port: typeof address === "object" && address ? address.port : config.httpPort
          });
          resolve();
        });
      });
    },
    address() {
      return server.address();
    },
    stop() {
      return new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
}
