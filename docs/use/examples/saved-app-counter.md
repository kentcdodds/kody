# Saved app example: counter backend

This example shows a saved app that uses both:

- **`clientCode`** for the UI
- **`serverCode`** for a Durable Object facet backend with isolated SQLite
  storage

Save it with **`ui_save_app`**, then reopen it with **`open_generated_ui`**.

## `clientCode`

```html
<main>
	<h1>Facet counter</h1>
	<p id="count-value">Loading...</p>
	<div style="display:flex;gap:0.5rem;">
		<button id="refresh-button" type="button">Refresh</button>
		<button id="increment-button" type="button">Increment</button>
	</div>
</main>

<script type="module">
	import { kodyWidget } from '@kody/ui-utils'

	const counterValue = document.querySelector('#count-value')
	const refreshButton = document.querySelector('#refresh-button')
	const incrementButton = document.querySelector('#increment-button')

	async function readCounter() {
		const basePath = kodyWidget.appBackend?.basePath
		if (!basePath) {
			throw new Error('Saved app backend is not available.')
		}
		const response = await fetch(`${basePath}/api/counter`)
		const payload = await response.json()
		counterValue.textContent = String(payload.count ?? 0)
	}

	async function incrementCounter() {
		const basePath = kodyWidget.appBackend?.basePath
		if (!basePath) {
			throw new Error('Saved app backend is not available.')
		}
		const response = await fetch(`${basePath}/api/counter`, {
			method: 'POST',
		})
		const payload = await response.json()
		counterValue.textContent = String(payload.count ?? 0)
	}

	refreshButton?.addEventListener('click', () => {
		void readCounter()
	})

	incrementButton?.addEventListener('click', () => {
		void incrementCounter()
	})

	void readCounter()
</script>
```

## `serverCode`

```ts
import { DurableObject } from 'cloudflare:workers'

export class App extends DurableObject {
	async fetch(request: Request) {
		const url = new URL(request.url)
		if (url.pathname === '/api/counter' && request.method === 'GET') {
			return Response.json({
				count: this.ctx.storage.kv.get('count') ?? 0,
			})
		}

		if (url.pathname === '/api/counter' && request.method === 'POST') {
			const nextCount = (this.ctx.storage.kv.get('count') ?? 0) + 1
			this.ctx.storage.kv.put('count', nextCount)
			return Response.json({ count: nextCount })
		}

		return new Response('Not found.', { status: 404 })
	}
}
```

## Save call

```json
{
	"title": "Facet counter",
	"description": "Simple counter app backed by a saved app Durable Object facet.",
	"clientCode": "<paste clientCode here>",
	"serverCode": "<paste serverCode here>",
	"hidden": false
}
```

## Notes

- The client talks to its backend with **`fetch('/app/<appId>/...')`**
  indirectly through **`kodyWidget.appBackend.basePath`**.
- The backend cannot make arbitrary outbound network calls. It only gets the
  explicit bridge bindings Kody passes in.
- Reset the stored counter with **`app_storage_reset({ app_id })`**.
