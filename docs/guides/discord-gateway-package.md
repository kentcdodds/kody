# Discord gateway package pattern

Use this guide when you want a **native Kody package** to own a Discord gateway
connection instead of relying on a separate external service.

This guide assumes:

- the package runtime already supports `package.json#kody.services`
- the package will likely also expose a package app for operator UI
- Discord credentials and downstream delivery details are handled separately

## Recommended package shape

Prefer one saved package with:

- `package.json#kody.app.entry` for setup UI, dashboards, and callback endpoints
- `package.json#kody.services.discord-gateway.entry` for the gateway runtime
- package exports for reusable helpers and formatting logic

Example manifest shape:

```json
{
  "name": "@scope/discord-gateway",
  "exports": {
    ".": "./src/index.ts",
    "./format-dispatch": "./src/format-dispatch.ts"
  },
  "kody": {
    "id": "discord-gateway",
    "description": "Native Discord gateway package",
    "app": {
      "entry": "./src/app.ts"
    },
    "services": {
      "discord-gateway": {
        "entry": "./src/services/discord-gateway.ts",
        "autoStart": true,
        "timeoutMs": 600000
      }
    }
  }
}
```

## Runtime model

Package services now run as **background-managed** service instances:

- `service_start` returns immediately with a running state
- the service Durable Object keeps lifecycle state such as
  `status`, `active_run_id`, `stop_requested`, and `next_alarm_at`
- the service module runs with:
  - `packageContext`
  - `serviceContext`
  - service-owned writable `storage`
  - a `service` helper from `kody:runtime`

Import shape inside a service module:

```ts
import { service, serviceContext, storage } from 'kody:runtime'
```

The `service` helper exposes:

- `await service.getStatus()`
- `await service.shouldStop()`
- `await service.setAlarm(runAt)`
- `await service.clearAlarm()`

## Recommended Discord gateway loop

Treat the service entry as the **gateway supervisor**, not just a one-shot job.

Recommended loop:

1. Load persisted session state from `storage`
   - token metadata / config references
   - Discord session id
   - last sequence number
   - resume URL
   - shard id / shard count
2. Open the outbound Discord WebSocket
3. Identify or resume
4. Enter a loop that:
   - reads gateway events
   - persists sequence/session updates before acting on them
   - publishes normalized events to the package app or package exports
   - periodically checks `await service.shouldStop()`
5. On clean shutdown:
   - close the socket
   - clear alarms when no reconnect is desired
6. On transient disconnect:
   - persist the latest resumable state
   - schedule reconnect with `await service.setAlarm(...)`
   - exit the current run

Pseudo-code shape:

```ts
import { service, storage } from 'kody:runtime'

export default async function run() {
  const session = (await storage.get('gateway-session')) ?? null
  const socket = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json')

  try {
    // Identify or resume here.

    while (socket.readyState === WebSocket.OPEN) {
      if (await service.shouldStop()) {
        socket.close(1000, 'service stop requested')
        await service.clearAlarm()
        return { stopped: true }
      }

      const event = await readNextDiscordEvent(socket)
      await persistGatewayState(storage, event)
      await handleGatewayEvent(event)
    }
  } catch (error) {
    await persistFailure(storage, error)
    await service.setAlarm(new Date(Date.now() + 5_000))
    throw error
  }
}
```

## Use the package app as the operator plane

Do not push all gateway interaction into the service itself.

Use the package app for:

- guild / shard health dashboards
- reconnect / pause / resume controls
- logs
- live dispatch inspection
- setup flows

The package app can call the package service lifecycle surface and consume
service status through the existing package runtime bridge.

## Prefer bounded reconnect loops over one immortal run

Cloudflare Durable Objects can open outbound WebSockets, but outgoing WebSockets
do **not** hibernate. Favor a design where the service can:

- reconnect intentionally
- reschedule itself with alarms
- persist resumable state early
- stop cooperatively

Use `timeoutMs` to give the gateway enough room to run, but do not rely on
indefinite execution as the only lifecycle mechanism.

## What to persist

At minimum, persist:

- `session_id`
- latest sequence / `s`
- shard id / count
- resume URL
- guild routing metadata if needed
- last error / last disconnect reason

Persist before any expensive or lossy downstream work so reconnects can resume
from durable state.

## Downstream delivery

A Discord gateway package usually needs a second delivery plane:

- package app realtime sessions for human/operator UIs
- package exports or jobs for reusable downstream logic

Keep gateway ingest, downstream formatting, and UI concerns separate so the
service can stay focused on connection lifecycle and event normalization.
