# Saved app example: `/api/state` + `/api/action`

This example shows the default saved-app backend structure for non-trivial apps:

- **`clientCode`** is mostly UI plus fetches to
  **`kodyWidget.appBackend.basePath`**
- **`serverCode`** owns storage, validation, and mutations
- the backend exposes **`GET /api/state`** and **`POST /api/action`**

Save it with **`ui_save_app`**, then reopen it with **`open_generated_ui`**.

## `clientCode`

```html
<main>
	<h1>Facet counter</h1>
	<p id="count-value">Loading...</p>
	<p id="error-message" role="alert" hidden></p>
	<div style="display:flex;gap:0.5rem;">
		<button id="refresh-button" type="button">Refresh</button>
		<button id="increment-button" type="button">Increment</button>
		<button id="reset-button" type="button">Reset</button>
	</div>
</main>

<script type="module">
	import { kodyWidget } from '@kody/ui-utils'

	const counterValue = document.querySelector('#count-value')
	const errorMessage = document.querySelector('#error-message')
	const refreshButton = document.querySelector('#refresh-button')
	const incrementButton = document.querySelector('#increment-button')
	const resetButton = document.querySelector('#reset-button')

	function showCounterError(message) {
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

	async function readStatePayload(response) {
		if (!response.ok) {
			throw new Error(`Counter request failed with ${response.status}.`)
		}
		const payload = await response.json().catch(() => null)
		if (!payload || typeof payload !== 'object') {
			throw new Error('Counter response JSON was invalid.')
		}
		return payload
	}

	async function loadState() {
		try {
			clearCounterError()
			const basePath = kodyWidget.appBackend?.basePath
			if (!basePath) {
				throw new Error('Saved app backend is not available.')
			}
			const response = await fetch(`${basePath}/api/state`)
			const payload = await readStatePayload(response)
			counterValue.textContent = String(payload.count ?? 0)
		} catch (error) {
			counterValue.textContent = 'Error'
			showCounterError(
				error instanceof Error ? error.message : 'Unable to load state.',
			)
		}
	}

	async function runAction(action) {
		try {
			clearCounterError()
			const basePath = kodyWidget.appBackend?.basePath
			if (!basePath) {
				throw new Error('Saved app backend is not available.')
			}
			const response = await fetch(`${basePath}/api/action`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action }),
			})
			const payload = await readStatePayload(response)
			counterValue.textContent = String(payload.count ?? 0)
		} catch (error) {
			counterValue.textContent = 'Error'
			showCounterError(
				error instanceof Error ? error.message : 'Unable to run action.',
			)
		}
	}

	refreshButton?.addEventListener('click', () => {
		void loadState()
	})

	incrementButton?.addEventListener('click', () => {
		void runAction('increment')
	})

	resetButton?.addEventListener('click', () => {
		void runAction('reset')
	})

	void loadState()
</script>
```

## `serverCode`

```ts
import { DurableObject } from 'cloudflare:workers'

export class App extends DurableObject {
	async fetch(request: Request) {
		const url = new URL(request.url)
		const count = Number((await this.ctx.storage.get('count')) ?? 0)

		if (url.pathname === '/api/state' && request.method === 'GET') {
			return Response.json({ count })
		}

		if (url.pathname === '/api/action' && request.method === 'POST') {
			const body = await request.json().catch(() => null)
			const nextCount =
				body?.action === 'increment'
					? count + 1
					: body?.action === 'reset'
						? 0
						: null
			if (nextCount === null) {
				return new Response('Unsupported action.', { status: 400 })
			}
			await this.ctx.storage.put('count', nextCount)
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
	"description": "Counter app that uses the default /api/state and /api/action backend pattern.",
	"clientCode": "<paste clientCode here>",
	"serverCode": "<paste serverCode here>",
	"hidden": false
}
```

## Notes

- This is a good default pattern for integration-backed apps too; replace the
  counter storage logic with connector lookups and provider API calls in
  **`serverCode`**.
- The client talks to its backend indirectly through
  **`kodyWidget.appBackend.basePath`**.
- The backend cannot make arbitrary outbound network calls. It only gets the
  explicit bridge bindings Kody passes in.
- Reset the stored counter with **`app_storage_reset({ app_id })`**.
