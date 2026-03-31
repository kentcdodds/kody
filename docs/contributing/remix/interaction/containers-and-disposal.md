# Containers and disposal

Source: https://github.com/remix-run/remix/tree/main/packages/interaction

## Updating listeners efficiently

Use `createContainer` when you need to update listeners in place (e.g., in a
component system). The container diffs and updates existing bindings without
unnecessary `removeEventListener`/`addEventListener` churn.

```ts
import { createContainer } from '@remix-run/interaction'

let container = createContainer(form)

let formData = new FormData()

container.set({
	change(event) {
		formData = new FormData(event.currentTarget)
	},
	async submit(event, signal) {
		event.preventDefault()
		await fetch('/save', { method: 'POST', body: formData, signal })
	},
})

// later - only the minimal necessary changes are rebound
container.set({
	change(event) {
		console.log('different listener')
	},
	submit(event, signal) {
		console.log('different listener')
	},
})
```

## Disposing listeners

`on` returns a dispose function. Containers expose `dispose()`. You can also
pass an external `AbortSignal`.

```ts
import { on, createContainer } from '@remix-run/interaction'

// Using the function returned from on()
let dispose = on(button, { click: () => {} })
dispose()

// Containers
let container = createContainer(window)
container.set({ resize: () => {} })
container.dispose()

// Use a signal
let eventsController = new AbortController()
let container = createContainer(window, {
	signal: eventsController.signal,
})
container.set({ resize: () => {} })
eventsController.abort()
```

## Stop propagation semantics

All DOM semantics are preserved.

```ts
on(button, {
	click: [
		(event) => {
			event.stopImmediatePropagation()
		},
		() => {
			// not called
		},
	],
})
```

## Navigation

- [Event listeners and interactions](./listeners.md)
- [interaction overview](./index.md)
- [Remix package index](../index.md)
