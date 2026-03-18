# Event listeners and interactions

Source: https://github.com/remix-run/remix/tree/main/packages/interaction

## Adding event listeners

Use `on(target, listeners)` to add one or more listeners. Each listener receives
`(event, signal)` where `signal` is aborted on reentry.

```ts
import { on } from '@remix-run/interaction'

let inputElement = document.createElement('input')

on(inputElement, {
	input: (event, signal) => {
		console.log('current value', event.currentTarget.value)
	},
})
```

Listeners can be arrays. They run in order and preserve normal DOM semantics
(including `stopImmediatePropagation`).

```ts
import { on } from '@remix-run/interaction'

on(inputElement, {
	input: [
		(event) => {
			console.log('first')
		},
		{
			capture: true,
			listener(event) {
				// capture phase
			},
		},
		{
			once: true,
			listener(event) {
				console.log('only once')
			},
		},
	],
})
```

## Built-in interactions

Builtin interactions are higher-level, semantic event types (e.g., `press`,
`longPress`, arrow keys) exported as string constants. Consume them just like
native events by using computed keys in your listener map. When you bind one,
the necessary underlying host events are set up automatically.

```tsx
import { on } from '@remix-run/interaction'
import { press, longPress } from '@remix-run/interaction/press'

on(listItem, {
	[press](event) {
		navigateTo(listItem.href)
	},

	[longPress](event) {
		event.preventDefault() // prevents `press`
		showActions()
	},
})
```

Import builtins from their modules (for example, `@remix-run/interaction/press`,
`@remix-run/interaction/keys`). Some interactions may coordinate with others
(for example, calling `event.preventDefault()` in one listener can prevent a
related interaction from firing).

## Async listeners and reentry protection

The `signal` is aborted when the same listener is re-entered (for example, a
user types quickly and triggers `input` repeatedly). Pass it to async APIs or
check it manually to avoid stale work.

```ts
on(inputElement, {
	async input(event, signal) {
		showSearchSpinner()

		// Abortable fetch
		let res = await fetch(`/search?q=${event.currentTarget.value}`, { signal })
		let results = await res.json()
		updateResults(results)
	},
})
```

For APIs that don't accept a signal:

```ts
on(inputElement, {
	async input(event, signal) {
		showSearchSpinner()
		let results = await someSearch(event.currentTarget.value)
		if (signal.aborted) return
		updateResults(results)
	},
})
```

## Event listener options

All DOM
[`AddEventListenerOptions`](https://developer.mozilla.org/en-US/docs/Web/API/EventTarget/addEventListener#options)
are supported via descriptors:

```ts
import { on } from '@remix-run/interaction'

on(button, {
	click: {
		capture: true,
		listener(event) {
			console.log('capture phase')
		},
	},
	focus: {
		once: true,
		listener(event) {
			console.log('focused once')
		},
	},
})
```

## Navigation

- [Containers and disposal](./containers-and-disposal.md)
- [interaction overview](./index.md)
- [Remix package index](../index.md)
