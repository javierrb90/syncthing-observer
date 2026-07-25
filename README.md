# Syncthing Observer

Small Node.js 22 service for a central Syncthing hub. It watches files that the monitored Syncthing instance receives from other devices and sends one Pushover notification after the affected folder has finished synchronizing.

The service has no runtime dependencies. It uses Syncthing's event API, a small built-in HTTP control server, persistent state, and a persistent notification outbox.

## Intended workflow

1. A console, computer, phone, or tablet changes a save file or screenshot.
2. Syncthing uploads the change to the MiniPC acting as the central hub.
3. Syncthing Observer sees the completed `ItemFinished` events on the MiniPC.
4. It correlates them with `RemoteChangeDetected` events to identify the device that originally modified the received version.
5. When the folder returns to `idle`, the observer waits for the configured quiet period.
6. If no new activity appears during that period, one Pushover notification is sent for the folder update.
7. Further successful updates from the same device to the same folder are ignored during the configurable cooldown.

Local filesystem changes discovered on the MiniPC are not monitored. Deleting or editing files directly on the hub therefore does not generate a successful synchronization notification.

## What it reports

- Received file, directory, symlink, update, and deletion operations applied by the MiniPC's Syncthing instance.
- One notification per settled folder update, rather than one notification per file.
- A compact message that starts with the Syncthing device name and does not expose filenames or item counts.
- The Syncthing device name that originated the received version, or all origin devices when a cycle contains changes from several devices.
- A per-device, per-folder cooldown that suppresses rapid repeated successful notifications without hiding updates to other folders or from other devices.
- Aggregated synchronization errors, with one sample item and error detail when available.
- All current and future Syncthing folders automatically.

Folder names are resolved in this order:

1. `FOLDER_NAMES_JSON`, when an explicit override exists.
2. The label configured in Syncthing.
3. The Syncthing Folder ID.

The observer reloads Syncthing metadata after a `ConfigSaved` event, so newly added folders, devices, and renamed labels or device names are picked up without changing the application. Device names come directly from Syncthing; no device mapping is required in `.env`.


## Device-origin detection

The observer uses two independent Syncthing event streams. The main `/rest/events` stream watches `ItemFinished`, `StateChanged`, and `ConfigSaved`; the dedicated `/rest/events/disk` stream watches disk-change events and keeps only `RemoteChangeDetected`. That event provides Syncthing's short `modifiedBy` device ID. The observer resolves it against `/rest/config/devices` and uses the configured device name in the Pushover message. Keeping separate cursors is important because Syncthing maintains separate subscriptions and event IDs for different event masks.

The device name shown at the beginning of the message is the device that originally modified the received file version. It is not necessarily the peer that physically supplied every data block to the MiniPC. If several devices originated files in the same aggregated folder cycle, every unique device name is listed. If Syncthing does not provide enough information, the message begins with `Dispositivo no identificado`.

## Pushover requirements

You need two values from your Pushover account:

- `PUSHOVER_APP_TOKEN`: create an application in the Pushover dashboard and copy its API token.
- `PUSHOVER_USER_KEY`: copy your user key from the Pushover dashboard.

`PUSHOVER_DEVICE` is optional. Leave it blank to deliver the message to all active devices registered under that user key. Set it to a Pushover device name to restrict delivery.

Successful updates use normal priority (`0`). Synchronization errors use high priority (`1`). Optional sound overrides can be configured separately.

## Configuration

Copy the example file:

```bash
cp .env.example .env
```

Required variables:

| Variable | Description |
|---|---|
| `SYNCTHING_URL` | Syncthing GUI/API URL without a trailing slash. |
| `SYNCTHING_API_KEY` | Syncthing API key. |
| `PUSHOVER_APP_TOKEN` | Pushover application API token. |
| `PUSHOVER_USER_KEY` | Pushover user or group key. |
| `TEST_API_TOKEN` | Secret protecting the HTTP notification test endpoint; at least 16 characters. |

Optional variables:

| Variable | Default | Description |
|---|---:|---|
| `STATE_FILE` | `/data/state.json` | Persistent state and notification outbox. |
| `FOLDER_NAMES_JSON` | `{}` | Optional Folder ID to display-name overrides. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, or `silent`. |
| `QUIET_PERIOD_SECONDS` | `10` | Seconds a folder must remain idle before its notification is queued. |
| `SYNC_COOLDOWN_SECONDS` | `60` | Suppresses another successful notification from the same device to the same folder during this period. Set to `0` to disable. |
| `EVENT_TIMEOUT_SECONDS` | `60` | Syncthing long-poll timeout. |
| `RECONNECT_MIN_DELAY_MS` | `1000` | Initial Syncthing reconnect delay. |
| `RECONNECT_MAX_DELAY_MS` | `30000` | Maximum Syncthing reconnect delay. |
| `PUSHOVER_DEVICE` | empty | Optional specific Pushover device. |
| `PUSHOVER_SOUND` | empty | Optional sound for successful updates. |
| `PUSHOVER_ERROR_SOUND` | empty | Optional sound for synchronization errors. |
| `NOTIFICATION_TIMEOUT_MS` | `10000` | Timeout for one Pushover API request. |
| `NOTIFICATION_ATTEMPTS` | `5` | Attempts made before leaving a message in the outbox. |
| `NOTIFICATION_RETRY_DELAY_SECONDS` | `60` | Delay between Pushover API attempts. |
| `OUTBOX_RETRY_DELAY_SECONDS` | `300` | Delay before retrying an undelivered outbox message. |
| `HTTP_HOST` | `0.0.0.0` | Address for the control server. |
| `HTTP_PORT` | `8787` | Control-server port. |

## Quiet-period behavior

The quiet period starts only after Syncthing reports the folder as `idle`.

If ten files are being synchronized and one takes several minutes, the timer does not start until that last file has finished and the folder is idle. If new activity begins during the quiet period, the timer is cancelled and restarted after the folder becomes idle again.

With the default configuration, the result is one notification ten seconds after the complete update has settled. After that notification is queued, further successful updates from the same device to the same folder are ignored for sixty seconds. The cooldown is persisted in `state.json`, survives container restarts, and does not suppress synchronization errors. A different device or a different folder can still notify immediately.

## Notification examples

Successful update:

```text
Syncthing · (Saves) PCSX2 (PS2)
AYN Thor · Sincronización recibida.
```

Update with errors:

```text
Syncthing · Error · (Saves) PCSX2 (PS2)
AYN Thor · Error de sincronización.
Elemento: memcards/Mcd001.ps2
Detalle: permission denied
```

## Testing Pushover with curl

The application exposes a fixed protected test action. It does not allow arbitrary notification text.

From the Docker host:

```bash
curl -X POST http://127.0.0.1:8787/test-notification \
  -H "Authorization: Bearer YOUR_TEST_API_TOKEN"
```

Alternatively:

```bash
curl -X POST http://127.0.0.1:8787/test-notification \
  -H "X-Test-Token: YOUR_TEST_API_TOKEN"
```

Successful response:

```json
{"ok":true,"message":"Pushover test notification sent","requestId":"..."}
```

An invalid Pushover token or user key produces HTTP `502` with the error returned by Pushover. A missing or invalid test token produces HTTP `401`.

Health check:

```bash
curl http://127.0.0.1:8787/health
```

Example response:

```json
{
  "ok": true,
  "syncthingConnected": true,
  "mainEventStreamConnected": true,
  "diskEventStreamConnected": true,
  "instanceId": "DEVICE-ID",
  "instanceName": "MiniPC",
  "folders": 20,
  "pendingNotifications": 0
}
```

## Event-stream troubleshooting

The main and disk event streams are intentionally polled separately. If device-origin detection is added to an existing deployment, look for this one-time migration log after rebuilding:

```text
event=event_cursors_migrated cursorSchemaVersion=2 lastMainEvent=... lastDiskEvent=...
```

Then perform a new synchronization. No `.env` change is required for this migration. The `/health` response reports the status of both streams independently.

## Local development

```bash
npm start
```

The start command uses Node.js 22 native environment-file support:

```text
node --env-file-if-exists=.env src/index.js
```

Syntax and automated tests:

```bash
npm run check
npm test
```

## Docker Compose

Fill in `.env`, then build and start:

```bash
docker compose up -d --build
```

View logs:

```bash
docker compose logs -f syncthing-observer
```

Run the Pushover test from the Docker host after the health endpoint responds.

## First start

On its first start, the observer requests only the latest buffered event ID from both the main and disk streams and persists them without generating notifications. Historical Syncthing events are ignored.

When upgrading from a version that used a single combined cursor, the application performs the same one-time cursor migration. The first new synchronization after the `event_cursors_migrated` log entry is observed normally.

## Persistent state and delivery

`state.json` contains:

- The last processed event ID for the main Syncthing stream.
- The last processed event ID for the disk-change stream.
- Folder activity that has not yet reached the end of its quiet period.
- Per-device, per-folder cooldown timestamps.
- A persistent notification outbox.

When an update is ready, it is written to the outbox before sending it to Pushover. A temporary Pushover outage or a container restart therefore does not discard the notification. State writes use a temporary file and atomic rename.

## Security notes

- This private repository intentionally tracks `.env`; `.gitignore` does not exclude it. Never make the repository public while it contains real credentials.
- `.dockerignore` still excludes `.env`, so the credentials are injected by Docker Compose at runtime rather than copied into the image.
- Do not hardcode the Syncthing API key or Pushover keys in `docker-compose.yml`.
- Keep port `8787` on the trusted LAN and use a long random `TEST_API_TOKEN`.
- Syncthing API authentication uses the `X-API-Key` header.
