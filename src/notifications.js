import { setTimeout as sleep } from "node:timers/promises";

const MAX_TITLE_LENGTH = 250;
const MAX_MESSAGE_LENGTH = 1024;

function truncate(value, maxLength) {
  const text = String(value ?? "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function itemCountText(count) {
  return count === 1 ? "1 elemento sincronizado." : `${count} elementos sincronizados.`;
}

function originText(originDeviceNames, { unknown = false } = {}) {
  const names = Array.isArray(originDeviceNames)
    ? [...new Set(originDeviceNames.map(String).filter(Boolean))]
    : [];

  if (names.length === 0) return unknown ? "Origen: no identificado." : null;
  return `Origen: ${names.join(", ")}.`;
}

export function buildPushoverMessage(notification, config) {
  const instanceName = notification.instanceName || "MiniPC";
  let title;
  let message;
  let priority = 0;
  let sound = config.pushoverSound;

  if (notification.type === "sync_completed") {
    title = `Syncthing · ${notification.folderName}`;
    message = [
      `Actualización recibida en ${instanceName}.`,
      itemCountText(notification.count || 0),
      originText(notification.originDeviceNames, { unknown: true })
    ].join("\n");
  } else if (notification.type === "sync_error") {
    title = `Syncthing · Error`;
    priority = 1;
    sound = config.pushoverErrorSound || config.pushoverSound;

    const summary = [];
    if (notification.count > 0) summary.push(itemCountText(notification.count));
    if (notification.errorCount > 0) {
      summary.push(
        notification.errorCount === 1
          ? "1 error detectado."
          : `${notification.errorCount} errores detectados.`
      );
    }

    message = [
      notification.folderName,
      `La sincronización terminó con errores en ${instanceName}.`,
      ...summary,
      originText(notification.originDeviceNames),
      notification.samplePath ? `Elemento: ${notification.samplePath}` : null,
      notification.sampleError ? `Detalle: ${notification.sampleError}` : null
    ].filter(Boolean).join("\n");
  } else if (notification.type === "test") {
    title = "Syncthing Observer · Prueba";
    message = [
      "La conexión con Pushover funciona correctamente.",
      `Servidor: ${instanceName}`
    ].join("\n");
  } else {
    throw new Error(`Unsupported notification type: ${notification.type}`);
  }

  const payload = {
    token: config.pushoverAppToken,
    user: config.pushoverUserKey,
    title: truncate(title, MAX_TITLE_LENGTH),
    message: truncate(message, MAX_MESSAGE_LENGTH),
    priority
  };

  if (config.pushoverDevice) payload.device = config.pushoverDevice;
  if (sound) payload.sound = sound;

  const timestamp = Date.parse(notification.timestamp || "");
  if (Number.isFinite(timestamp)) payload.timestamp = Math.floor(timestamp / 1000);

  return payload;
}

function shouldRetry(status) {
  return status === 429 || status >= 500;
}

async function readJsonSafely(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function createNotificationClient(config, logger, shutdownSignal) {
  async function postOnce(notification) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.notificationTimeoutMs);
    const abortFromShutdown = () => controller.abort();
    shutdownSignal.addEventListener("abort", abortFromShutdown, { once: true });

    try {
      const response = await fetch(config.pushoverApiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json"
        },
        body: JSON.stringify(buildPushoverMessage(notification, config)),
        signal: controller.signal
      });

      const body = await readJsonSafely(response);
      const delivered = response.ok && body?.status === 1;

      return {
        delivered,
        retry: !delivered && shouldRetry(response.status),
        status: response.status,
        requestId: body?.request || null,
        error: Array.isArray(body?.errors)
          ? body.errors.join("; ")
          : delivered
            ? null
            : `Pushover returned HTTP ${response.status}`
      };
    } finally {
      clearTimeout(timeout);
      shutdownSignal.removeEventListener("abort", abortFromShutdown);
    }
  }

  async function send(notification) {
    for (let attempt = 1; attempt <= config.notificationAttempts; attempt += 1) {
      if (shutdownSignal.aborted) {
        return { delivered: false, aborted: true, error: "application_shutdown" };
      }

      try {
        const result = await postOnce(notification);

        if (result.delivered) {
          logger.info("pushover_notification_sent", {
            notificationId: notification.id || null,
            folderId: notification.folderId || null,
            type: notification.type,
            attempt,
            status: result.status,
            requestId: result.requestId
          });
          return result;
        }

        logger.warn("pushover_notification_rejected", {
          notificationId: notification.id || null,
          folderId: notification.folderId || null,
          type: notification.type,
          attempt,
          status: result.status,
          requestId: result.requestId,
          error: result.error
        });

        if (!result.retry) return result;
      } catch (error) {
        if (shutdownSignal.aborted) {
          return { delivered: false, aborted: true, error: "application_shutdown" };
        }

        logger.warn("pushover_notification_attempt_failed", {
          notificationId: notification.id || null,
          folderId: notification.folderId || null,
          type: notification.type,
          attempt,
          error: error.name === "AbortError" ? "request_timeout" : error.message
        });
      }

      if (attempt < config.notificationAttempts) {
        try {
          await sleep(config.notificationRetryDelayMs, undefined, { signal: shutdownSignal });
        } catch {
          return { delivered: false, aborted: true, error: "application_shutdown" };
        }
      }
    }

    logger.error("pushover_notification_failed", {
      notificationId: notification.id || null,
      folderId: notification.folderId || null,
      type: notification.type,
      attempts: config.notificationAttempts
    });

    return { delivered: false, retry: true, error: "retry_limit_reached" };
  }

  return Object.freeze({ send });
}
