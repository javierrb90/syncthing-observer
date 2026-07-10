import { setTimeout as sleep } from "node:timers/promises";

function isSuccess(status) {
  return status >= 200 && status < 300;
}

function shouldRetry(status) {
  return status === 429 || status >= 500;
}

export function createNotificationClient(config, logger, shutdownSignal) {
  async function postOnce(payload) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.notificationTimeoutMs);

    const abortFromShutdown = () => controller.abort();
    shutdownSignal.addEventListener("abort", abortFromShutdown, { once: true });

    try {
      const response = await fetch(config.notificationsUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (isSuccess(response.status)) {
        return { delivered: true, retry: false, status: response.status };
      }

      return {
        delivered: false,
        retry: shouldRetry(response.status),
        status: response.status
      };
    } finally {
      clearTimeout(timeout);
      shutdownSignal.removeEventListener("abort", abortFromShutdown);
    }
  }

  async function send(payload) {
    for (let attempt = 1; attempt <= config.notificationAttempts; attempt += 1) {
      if (shutdownSignal.aborted) return false;

      try {
        const result = await postOnce(payload);

        if (result.delivered) {
          logger.info("notification_sent", {
            externalId: payload.externalId,
            folderId: payload.meta?.folderId,
            type: payload.type,
            attempt,
            status: result.status
          });
          return true;
        }

        logger.warn("notification_rejected", {
          externalId: payload.externalId,
          folderId: payload.meta?.folderId,
          type: payload.type,
          attempt,
          status: result.status
        });

        if (!result.retry) return false;
      } catch (error) {
        if (shutdownSignal.aborted) return false;

        logger.warn("notification_attempt_failed", {
          externalId: payload.externalId,
          folderId: payload.meta?.folderId,
          type: payload.type,
          attempt,
          error: error.name === "AbortError" ? "request_timeout" : error.message
        });
      }

      if (attempt < config.notificationAttempts) {
        try {
          await sleep(config.notificationRetryDelayMs, undefined, { signal: shutdownSignal });
        } catch {
          return false;
        }
      }
    }

    logger.error("notification_failed", {
      externalId: payload.externalId,
      folderId: payload.meta?.folderId,
      type: payload.type,
      attempts: config.notificationAttempts
    });
    return false;
  }

  return { send };
}
