# Event handling basics

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/events.md

Event handling with the `on` prop and signal-based interruption management.

## Basic event handling

Use the `on` prop to attach event listeners to elements:

```tsx
function Button(handle: Handle) {
	let count = 0

	return () => (
		<button
			on={{
				click() {
					count++
					handle.update()
				},
			}}
		>
			Clicked {count} times
		</button>
	)
}
```

## Event handler signature

Event handlers receive the event object and an optional `AbortSignal`:

```tsx
on={{
  click(event) {
    // event is the DOM event
    event.preventDefault()
  },
  async input(event, signal) {
    // signal is aborted when handler is re-entered or component removed
    let response = await fetch('/api', { signal })
  }
}}
```

## Signals in event handlers

Event handlers receive an `AbortSignal` that's automatically aborted when:

- The handler is re-entered (user triggers another event before the previous one
  completes)
- The component is removed from the tree

This prevents race conditions when users create events faster than async work
completes:

```tsx
function SearchInput(handle: Handle) {
	let results: string[] = []
	let loading = false

	return () => (
		<div>
			<input
				type="text"
				on={{
					async input(event, signal) {
						let query = event.currentTarget.value
						loading = true
						handle.update()

						// Passing signal automatically aborts previous requests
						let response = await fetch(`/search?q=${query}`, { signal })
						let data = await response.json()
						// Manual check for APIs that don't accept a signal
						if (signal.aborted) return

						results = data.results
						loading = false
						handle.update()
					},
				}}
			/>
			{loading && <div>Loading...</div>}
			{!loading && results.length > 0 && (
				<ul>
					{results.map((result, i) => (
						<li key={i}>{result}</li>
					))}
				</ul>
			)}
		</div>
	)
}
```

The signal ensures only the latest search request completes, preventing stale
results from overwriting newer ones.

## Navigation

- [Event patterns](./events-patterns.md)
- [Component index](./index.md)
