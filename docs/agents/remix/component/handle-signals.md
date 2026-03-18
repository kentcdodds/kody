# Handle signals and listeners

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/handle.md

## `handle.signal`

An `AbortSignal` that's aborted when the component is disconnected. Useful for
cleanup operations.

```tsx
function Clock(handle: Handle) {
	let interval = setInterval(() => {
		if (handle.signal.aborted) {
			clearInterval(interval)
			return
		}
		handle.update()
	}, 1000)

	return () => <div>{new Date().toString()}</div>
}
```

Or using event listeners:

```tsx
function Clock(handle: Handle) {
	let interval = setInterval(handle.update, 1000)
	handle.signal.addEventListener('abort', () => clearInterval(interval))

	return () => <div>{new Date().toString()}</div>
}
```

## `handle.on(target, listeners)`

Listen to an `EventTarget` with automatic cleanup when the component
disconnects. Ideal for global event targets like `document` and `window`.

```tsx
function KeyboardTracker(handle: Handle) {
	let keys: string[] = []

	handle.on(document, {
		keydown(event) {
			keys.push(event.key)
			handle.update()
		},
	})

	return () => <div>Keys: {keys.join(', ')}</div>
}
```

## `handle.id`

Stable identifier per component instance. Useful for HTML APIs like `htmlFor`,
`aria-owns`, etc.

```tsx
function LabeledInput(handle: Handle) {
	return () => (
		<div>
			<label htmlFor={handle.id}>Name</label>
			<input id={handle.id} />
		</div>
	)
}
```

## Navigation

- [Handle updates and tasks](./handle-updates.md)
- [Handle context](./handle-context.md)
- [Component index](./index.md)
