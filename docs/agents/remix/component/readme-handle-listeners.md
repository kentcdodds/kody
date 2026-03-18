# Component README: handle listeners

Source: https://github.com/remix-run/remix/tree/main/packages/component

## `handle.on(target, listeners)`

Listen to an
[EventTarget](https://developer.mozilla.org/en-US/docs/Web/API/EventTarget) with
automatic cleanup when the component disconnects. Ideal for listening to events
on global event targets like `document` and `window`.

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

The listeners are automatically removed when the component is disconnected, so
you don't need to manually clean up.

## `handle.signal`

An `AbortSignal` that's aborted when the component is disconnected. Useful for
cleanup operations.

```tsx
function Clock(handle: Handle) {
	let interval = setInterval(() => {
		// clear the interval when the component is disconnected
		if (handle.signal.aborted) {
			clearInterval(interval)
			return
		}
		handle.update()
	}, 1000)
	return () => <span>{new Date().toString()}</span>
}
```

## `handle.id`

Stable identifier per component instance. Useful for HTML APIs like `htmlFor`,
`aria-owns`, etc. so consumers don't have to supply an id.

```tsx
function LabeledInput(handle: Handle) {
	return () => (
		<div>
			<label htmlFor={handle.id}>Name</label>
			<input id={handle.id} type="text" />
		</div>
	)
}
```

## Navigation

- [Handle API reference](./readme-handle-api.md)
- [Handle context](./readme-handle-context.md)
- [Component index](./index.md)
