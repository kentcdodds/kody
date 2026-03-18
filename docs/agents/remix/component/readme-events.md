# Component README: events

Source: https://github.com/remix-run/remix/tree/main/packages/component

## Events

Events use the `on` prop and are handled by
[`@remix-run/interaction`](../interaction/index.md). Listeners receive an
`AbortSignal` that's aborted when the component is disconnected or the handler
is re-entered.

```tsx
function SearchInput(handle: Handle) {
	let query = ''

	return () => (
		<input
			type="text"
			value={query}
			on={{
				input: (event, signal) => {
					query = event.currentTarget.value
					handle.update()

					// Pass the signal to abort the fetch on re-entry or node removal
					// This avoids race conditions in the UI and manages cleanup
					fetch(`/search?q=${query}`, { signal })
						.then((res) => res.json())
						.then((results) => {
							if (signal.aborted) return
							// Update results
						})
				},
			}}
		/>
	)
}
```

You can also listen to global event targets like `document` or `window` using
`handle.on()` with automatic cleanup on component removal:

```tsx
function KeyboardTracker(handle: Handle) {
	let keys: string[] = []

	handle.on(document, {
		keydown: (event) => {
			keys.push(event.key)
			handle.update()
		},
	})

	return () => <div>Keys: {keys.join(', ')}</div>
}
```

## Navigation

- [Styling and DOM connections](./readme-styling-and-connect.md)
- [Handle API reference](./readme-handle-api.md)
- [Component index](./index.md)
