# Package service pattern

Use this guide when you want a **native Kody package** to own a long-lived
runtime instead of relying on a separate external service.

This guide assumes:

- the package runtime already supports `package.json#kody.services`
- the package will likely also expose a package app for operator UI
- protocol credentials and downstream delivery details are handled separately

## Recommended package shape

Prefer one saved package with:

- `package.json#kody.app.entry` for setup UI, dashboards, and callback endpoints
- `package.json#kody.services.realtime-supervisor.entry` for the long-lived
  runtime
- package exports for reusable helpers and formatting logic

Example manifest shape:

```json
{
	"name": "@scope/realtime-supervisor",
	"exports": {
		".": "./src/index.ts",
		"./format-event": "./src/format-event.ts"
	},
	"kody": {
		"id": "realtime-supervisor",
		"description": "Native long-lived service package",
		"app": {
			"entry": "./src/app.ts"
		},
		"services": {
			"realtime-supervisor": {
				"entry": "./src/services/realtime-supervisor.ts",
				"autoStart": true,
				"timeoutMs": 300000
			}
		}
	}
}
```

## Runtime model

Package services run as **background-managed** service instances:

- `service_start` returns immediately with a running state
- the service Durable Object keeps lifecycle state such as `status`,
  `active_run_id`, `stop_requested`, and `next_alarm_at`
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

## Recommended service loop

Treat the service entry as a **runtime supervisor**, not just a one-shot job.

Recommended loop:

1. Load persisted session state from `storage`
   - configuration references
   - last checkpoint / cursor / offset
   - reconnect endpoint or transport metadata
   - topology metadata if applicable
2. Open the outbound connection or initialize the runtime session
3. Authenticate, subscribe, or resume
4. Enter a loop that:
   - reads remote events or messages
   - persists resumable state before acting on them
   - publishes normalized events to the package app or package exports
   - periodically checks `await service.shouldStop()`
5. On clean shutdown:
   - close the connection
   - clear alarms when no reconnect is desired
6. On transient disconnect:
   - persist the latest resumable state
   - schedule reconnect with `await service.setAlarm(...)`
   - exit the current run

Pseudo-code shape:

```ts
import { service, storage } from 'kody:runtime'

async function openSocket(session: unknown) {
	void session
	return await new Promise<WebSocket>((resolve, reject) => {
		const socket = new WebSocket('wss://example.com/stream')
		socket.addEventListener('open', () => resolve(socket), { once: true })
		socket.addEventListener(
			'error',
			() => reject(new Error('Failed to open stream')),
			{
				once: true,
			},
		)
	})
}

export default async function run() {
	const session = (await storage.get('session-state')) ?? null
	const socket = await openSocket(session)

	try {
		// Authenticate, subscribe, or resume here.

		while (
			socket.readyState !== WebSocket.CLOSING &&
			socket.readyState !== WebSocket.CLOSED
		) {
			if (await service.shouldStop()) {
				socket.close(1000, 'service stop requested')
				await service.clearAlarm()
				return { stopped: true }
			}

			const event = await readNextEvent(socket)
			await persistRuntimeState(storage, event)
			await handleRuntimeEvent(event)
		}
	} catch (error) {
		await persistFailure(storage, error)
		await service.setAlarm(new Date(Date.now() + 5_000))
		throw error
	}
}
```

## Use the package app as the operator plane

Do not push all operational interaction into the service itself.

Use the package app for:

- health dashboards
- reconnect / pause / resume controls
- logs
- live event inspection
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

Use `timeoutMs` to give the service enough room to run, but do not rely on
indefinite execution as the only lifecycle mechanism.

## What to persist

At minimum, persist:

- reconnect/session identifiers
- latest offset / sequence / cursor
- topology metadata if needed
- reconnect URL or endpoint metadata
- last error / last disconnect reason

Persist before any expensive or lossy downstream work so reconnects can resume
from durable state.

## Downstream delivery

A long-lived package service usually needs a second delivery plane:

- package app realtime sessions for human/operator UIs
- package exports or jobs for reusable downstream logic

Keep connection ingest, downstream formatting, and UI concerns separate so the
service can stay focused on connection lifecycle and event normalization.
