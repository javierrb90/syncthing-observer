# Syncthing Activity Notifier

Small Node.js 22 service that listens to Syncthing through long polling and sends one notification per updated folder to a LAN notification center.

It has no runtime dependencies, exposes no ports, uses no periodic folder-state polling, and is ready to deploy with Docker or Portainer.

## What it reports

- Received creations, modifications and deletions applied by the monitored Syncthing instance.
- Local creations, modifications and deletions detected by Syncthing.
- Files, directories and symlinks.
- Folder synchronization errors.
- One notification when the folder returns to `idle`.
- At most one sample path in `meta.files`.

Metadata-only changes are ignored.

`local` means that Syncthing detected a local filesystem change. It does not claim that every remote device has already downloaded it.

## Required configuration

| Variable | Description |
|---|---|
| `SYNCTHING_URL` | Syncthing GUI/API URL, without a trailing slash. |
| `SYNCTHING_API_KEY` | Syncthing API key. |
| `NOTIFICATIONS_URL` | Full endpoint, normally `http://kiosko.local:3000/api/notifications`. |

## Optional configuration

| Variable | Default | Description |
|---|---:|---|
| `STATE_FILE` | `/data/state.json` | Persistent state path. |
| `SYNC_DIRECTION` | `both` | `received`, `local`, or `both`. |
| `FOLDER_NAMES_JSON` | `{}` | JSON map from Folder ID to friendly name. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, or `silent`. |
| `EVENT_TIMEOUT_SECONDS` | `60` | Syncthing long-poll timeout. |
| `RECONNECT_MIN_DELAY_MS` | `1000` | Initial reconnect delay. |
| `RECONNECT_MAX_DELAY_MS` | `30000` | Maximum reconnect delay. |
| `NOTIFICATION_TIMEOUT_MS` | `10000` | Timeout for each notification request. |
| `DEDUPLICATION_WINDOW_SECONDS` | `60` | Reuses the same `externalId` for consecutive completions of the same folder and direction inside this rolling window. Set to `0` to disable. |

Folder names are resolved in this order:

1. `FOLDER_NAMES_JSON`
2. Syncthing folder label
3. Folder ID

## Direction modes

```text
received  Changes downloaded and applied by this Syncthing instance
local     Changes detected on the local filesystem
both      Both categories
```

When both categories occur before the same return to `idle`, they are combined into one notification with `meta.direction` set to `both`.

## First start

On the first start, the service requests only the latest buffered event ID from each Syncthing event stream and stores it without generating notifications. Historical events are therefore ignored.

Subsequent starts continue from the persisted IDs.

## Notification example

```json
{
  "source": "syncthing",
  "type": "sync_completed",
  "priority": "normal",
  "title": "Capturas de pantalla",
  "subtitle": "Synchronization received",
  "externalId": "syncthing:DEVICE_ID:screenshots:received:184563",
  "meta": {
    "folderId": "screenshots",
    "folderName": "Capturas de pantalla",
    "timestamp": "2026-07-10T21:13:42+02:00",
    "count": 3,
    "files": [
      "Pantalla 1.png"
    ],
    "direction": "received",
    "instanceId": "DEVICE_ID",
    "instanceName": "MiniPC"
  }
}
```

The notifier uses `externalId` so retries are safely deduplicated by Kiosko Media Center.


## Temporal deduplication

Some workflows produce two real Syncthing cycles for one user action. A common example is:

1. a file is received;
2. another process immediately moves it;
3. Syncthing detects and synchronizes the move.

Those cycles have different Syncthing event IDs, so event-ID idempotency alone cannot identify them as one logical update.

The notifier therefore keeps a rolling deduplication window per instance, folder and direction. Consecutive completions inside `DEDUPLICATION_WINDOW_SECONDS` reuse the same `externalId`. Kiosko Media Center then returns the existing notification instead of creating another toast.

The default is 60 seconds:

```env
DEDUPLICATION_WINDOW_SECONDS=60
```

A new completion inside the window extends the window from that event. The mapping is persisted in `state.json`, so a notifier restart does not immediately reintroduce the duplicate.

## Retry behavior

A failed notification is attempted at most five times:

- first attempt immediately;
- four further attempts;
- five minutes between attempts.

HTTP `429` and `5xx` responses are retried. Other `4xx` responses are treated as permanent errors. Retries are kept only in memory.


## Local development

Copy the example environment file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Edit `.env` and run:

```bash
npm start
```

The start command uses Node.js 22 native environment-file support:

```text
node --env-file-if-exists=.env src/index.js
```

If `.env` does not exist, the service uses environment variables provided by the operating system or Docker.

## Docker Compose

Edit `docker-compose.yml`, especially the API key:

```yaml
services:
  syncthing-activity-notifier:
    build:
      context: .
    restart: unless-stopped
    init: true
    environment:
      SYNCTHING_URL: "http://ssrb.local:8384"
      SYNCTHING_API_KEY: "REPLACE_WITH_YOUR_API_KEY"
      NOTIFICATIONS_URL: "http://kiosko.local:3000/api/notifications"
      SYNC_DIRECTION: "both"
      FOLDER_NAMES_JSON: '{"screenshots":"Capturas de pantalla"}'
      LOG_LEVEL: "info"
      DEDUPLICATION_WINDOW_SECONDS: "60"
    volumes:
      - syncthing-notifier-data:/data
```

Build and start:

```bash
docker compose up -d --build
```

View logs:

```bash
docker compose logs -f
```

## Portainer

1. Create a Git repository containing this project, or upload it to a location Portainer can build from.
2. Create a new Stack.
3. Use the included `docker-compose.yml`.
4. Replace `SYNCTHING_API_KEY` and adjust the URLs and folder-name mapping.
5. Deploy the stack.

No port mapping is required.

## State

The persistent file contains:

```json
{
  "initialized": true,
  "lastMainEvent": 184563,
  "lastDiskEvent": 922,
  "folders": {}
}
```

Open folder activity is also persisted so a container restart does not discard a synchronization already in progress.

State writes are atomic through a temporary file and rename.

## Logs

Logs are minimal JSON lines suitable for Docker and Portainer. Individual Syncthing events are logged only when `LOG_LEVEL=debug`.

## Notes

- Syncthing API authentication uses the `X-API-Key` header.
- The service monitors all configured folders.
- `ItemFinished` actions marked as `metadata` are ignored.
- Successful `update` and `delete` actions are counted.
- Folder and directory changes are included.
- Error notifications identify the monitored Syncthing instance. Syncthing's `ItemFinished` and folder-state error events do not always identify a remote peer.
