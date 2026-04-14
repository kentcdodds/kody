# Saved app backends

Saved apps persist **two** code artifacts:

- **`clientCode`** — HTML for the generic MCP app shell
- **`serverCode`** — optional Durable Object code that runs behind
  **`/app/:appId/*`**

Every saved app gets its own **`AppRunner`** supervisor Durable Object. When the
app defines **`serverCode`**, the supervisor loads the saved code as a **Durable
Object Facet** and gives it an isolated SQLite database.

## Save input shape

`ui_save_app` accepts camelCase fields:

```json
{
	"app_id": "app-123",
	"title": "Counter app",
	"description": "Saved app with a backend counter",
	"clientCode": "<main>...</main>",
	"serverCode": "import { DurableObject } from 'cloudflare:workers'; ..."
}
```

`clientCode` supports **HTML only**. If the app needs browser-side logic,
include it inside `<script type="module">...</script>` tags in the HTML.

When **creating** a saved app, `title`, `description`, and `clientCode` are
required.

When **updating** an existing saved app with `app_id`, omitted fields preserve
their current saved values:

- omit `serverCode` to keep the current backend
- pass **`serverCode: null`** to clear the backend explicitly
- `server_code_id` only rotates when the saved backend actually changes

## Read shape

Saved app reads (`ui_get_app`, `ui_load_app_source`, generated UI source APIs)
return snake_case fields:

```json
{
	"app_id": "app-123",
	"client_code": "<main>...</main>",
	"server_code": "import { DurableObject } from 'cloudflare:workers'; ...",
	"server_code_id": "uuid"
}
```

`client_code` contains HTML. `server_code` contains Workers JavaScript.

## Authoring `serverCode`

Saved app server code must export:

```ts
import { DurableObject } from 'cloudflare:workers'

export class App extends DurableObject {
	async fetch(request: Request) {
		return new Response('ok')
	}
}
```

The facet has:

- its own **Durable Object SQLite storage**
- **no raw outbound network access**
- a **`KODY`** binding injected by the supervisor for safe access back into Kody

## The `/app/:appId/*` route

Saved app frontend code can call:

- `fetch('/app/<appId>/api/...')`

The request is authenticated with the same generated UI app session token Kody
already uses for saved app iframes. Kody also sets an app-scoped HttpOnly cookie
so ordinary relative `fetch()` calls from the iframe work without custom auth
code.

Inside generated UI code, read the base path from:

```ts
import { kodyWidget } from '@kody/ui-utils'

const backendBase = kodyWidget.appBackend?.basePath
```

## `KODY` facet bridge

Facet server code receives a **`KODY`** binding with a safe subset of Kody
behavior:

- `fetchWithResolvedSecrets({ url, method, headers, body })`
- `valueGet(name, scope?)`
- `valueSet({ name, value, description?, scope? })`
- `connectorGet(args)`
- `connectorList()`
- `metaRunSkill(name, params?)`
- `secretPlaceholder(name, scope?)`

The bridge is intentionally explicit. Facets do **not** inherit the normal
global `fetch()` capability.

## Lifecycle capabilities

Kody now exposes saved app backend lifecycle operations:

- `app_storage_reset({ app_id, facet_name? })`
- `app_storage_export({ app_id, facet_name? })`
- `app_server_exec({ app_id, facet_name?, code, params? })`
- `app_delete({ app_id })`

Facet names default to `main`. Kody reserves named facets such as `jobs` and
`cache` for future multi-facet saved apps.

## `app_server_exec` contract

`app_server_exec` does **not** eval source inside the running facet. Instead,
Kody compiles the provided `code` into a **throwaway Dynamic Worker** and binds
an explicit RPC bridge for the saved app facet.

Inside the snippet body you can access:

- **`app`** — explicit bridge with `app.call(methodName, ...args)` for invoking
  public RPC methods on the saved app `App` class
- **`params`** — optional JSON input passed through the capability

Example:

```ts
await codemode.app_server_exec({
	app_id: 'app-123',
	params: { amount: 2 },
	code: `
		return await app.call('incrementBy', params.amount ?? 1)
	`,
})
```

That means the saved app must expose explicit RPC methods on its exported `App`
class:

```ts
import { DurableObject } from 'cloudflare:workers'

export class App extends DurableObject {
	async incrementBy(amount = 1) {
		const current = Number((await this.ctx.storage.get('count')) ?? 0)
		const next = current + Number(amount)
		await this.ctx.storage.put('count', next)
		return { count: next }
	}
}
```

For raw SQLite inspection, use **`app_storage_export`** instead of
`app_server_exec`.

## Example: counter app

Save this app with `ui_save_app`:

```ts
await codemode.ui_save_app({
	title: 'Facet counter',
	description: 'Counter app with a real Durable Object backend',
	clientCode: `
		<main>
			<h1>Facet counter</h1>
			<button id="increment">Increment</button>
			<output id="count">0</output>
			<script type="module">
				import { kodyWidget } from '@kody/ui-utils'

				const button = document.querySelector('#increment')
				const output = document.querySelector('#count')
				const backendBase = kodyWidget.appBackend?.basePath

				async function refresh() {
					const response = await fetch(\`\${backendBase}/api/count\`)
					const payload = await response.json()
					output.textContent = String(payload.count)
				}

				button?.addEventListener('click', async () => {
					await fetch(\`\${backendBase}/api/count\`, { method: 'POST' })
					await refresh()
				})

				void refresh()
			</script>
		</main>
	`,
	serverCode: `
		import { DurableObject } from 'cloudflare:workers'

		export class App extends DurableObject {
			async fetch(request) {
				const url = new URL(request.url)
				const count = Number((await this.ctx.storage.get('count')) ?? 0)

				if (url.pathname === '/api/count' && request.method === 'GET') {
					return Response.json({ count })
				}

				if (url.pathname === '/api/count' && request.method === 'POST') {
					const nextCount = count + 1
					await this.ctx.storage.put('count', nextCount)
					return Response.json({ count: nextCount })
				}

				return new Response('Not found', { status: 404 })
			}
		}
	`,
	hidden: false,
})
```
