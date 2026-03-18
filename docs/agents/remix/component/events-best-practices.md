# Event best practices

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/events.md

## Prefer press events over click

For interactive elements, prefer `press` events over `click`. Press events
provide better cross-device behavior:

- Fire on both mouse and touch interactions
- Handle keyboard activation (Enter/Space) automatically
- Prevent ghost clicks on touch devices
- Support press-and-hold patterns

```tsx
// BAD: click doesn't handle all interaction modes well
<button on={{ click() { doAction() } }}>Action</button>

// GOOD: press handles mouse, touch, and keyboard uniformly
<button on={{ press() { doAction() } }}>Action</button>
```

Use `click` only when you specifically need mouse-click behavior (e.g.,
detecting right-clicks or modifier keys).

## Do work in event handlers

Do as much work as possible in event handlers. Use the event handler scope for
transient state:

```tsx
// GOOD: Do work in handler, only store what renders need
function SearchResults(handle: Handle) {
	let results: string[] = [] // Needed for rendering
	let loading = false // Needed for rendering loading state

	return () => (
		<div>
			<input
				on={{
					async input(event, signal) {
						let query = event.currentTarget.value
						// Do work in handler scope
						loading = true
						handle.update()

						let response = await fetch(`/search?q=${query}`, { signal })
						let data = await response.json()
						if (signal.aborted) return

						// Only store what's needed for rendering
						results = data.results
						loading = false
						handle.update()
					},
				}}
			/>
			{loading && <div>Loading...</div>}
			{results.map((result, i) => (
				<div key={i}>{result}</div>
			))}
		</div>
	)
}
```

## Always check `signal.aborted`

For async work, always check the signal or pass it to APIs that support it:

```tsx
on={{
  async click(event, signal) {
    // Option 1: Pass signal to fetch
    let response = await fetch('/api', { signal })

    // Option 2: Manual check after await
    let data = await someAsyncOperation()
    if (signal.aborted) return

    // Safe to update state
    handle.update()
  }
}}
```

## See also

- [Handle signals and listeners](./handle-signals.md)
- [Pattern: data loading](./patterns-data-loading.md)

## Navigation

- [Event patterns](./events-patterns.md)
- [Component index](./index.md)
