# Saved app example: counter backend

This example shows a saved app that uses both:

- **`clientCode`** for the UI
- **`serverCode`** for a Durable Object facet backend with isolated SQLite
  storage

Save it with **`ui_save_app`**, then reopen it with **`open_generated_ui`**.

`clientCode` supports **HTML only**. If the UI needs browser-side logic, include
it in `<script type="module">...</script>` tags in the HTML.

## `clientCode`

```html
<main>
	<h1>Facet counter</h1>
	<p id="count-value">Loading...</p>
	<p id="error-message" role="alert" hidden></p>
	<div style="display:flex;gap:0.5rem;">
		<button id="refresh-button" type="button">Refresh</button>
		<button id="increment-button" type="button">Increment</button>
	</div>
</main>

<script type="module">
	import { kodyWidget } from '@kody/ui-utils'

	const counterValue = document.querySelector('#count-value')
	const errorMessage = document.querySelector('#error-message')
	const refreshButton = document.querySelector('#refresh-button')
	const incrementButton = document.querySelector('#increment-button')

	function showCounterError(message) {
		console.error(message)
		if (errorMessage) {
			errorMessage.hidden = false
			errorMessage.textContent = message
		}
	}

	function clearCounterError() {
		if (errorMessage) {
			errorMessage.hidden = true
			errorMessage.textContent = ''
		}
	}

	async function readCounterPayload(response) {
		if (!response.ok) {
			throw new Error(`Counter request failed with ${response.status}.`)
		}
		const contentType = response.headers.get('content-type') ?? ''
		if (!contentType.includes('application/json')) {
			throw new Error('Counter response was not JSON.')
		}
		const payload = await response.json().catch(() => null)
		if (!payload || typeof payload !== 'object') {
			throw new Error('Counter response JSON was invalid.')
		}
		return payload
	}

	async function readCounter() {
		try {
			clearCounterError()
			const basePath = kodyWidget.appBackend?.basePath
			if (!basePath) {
				throw new Error('Saved app backend is not available.')
			}
			const response = await fetch(`${basePath}/api/counter`)
			const payload = await readCounterPayload(response)
			counterValue.textContent = String(payload.count ?? 0)
		} catch (error) {
			counterValue.textContent = 'Error'
			showCounterError(
				error instanceof Error ? error.message : 'Unable to load counter.',
			)
		}
	}

	async function incrementCounter() {
		try {
			clearCounterError()
			const basePath = kodyWidget.appBackend?.basePath
			if (!basePath) {
				throw new Error('Saved app backend is not available.')
			}
			const response = await fetch(`${basePath}/api/counter`, {
				method: 'POST',
			})
			const payload = await readCounterPayload(response)
			counterValue.textContent = String(payload.count ?? 0)
		} catch (error) {
			counterValue.textContent = 'Error'
			showCounterError(
				error instanceof Error ? error.message : 'Unable to increment counter.',
			)
		}
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
