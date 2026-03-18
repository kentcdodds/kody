# Handle updates and tasks

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/handle.md

The `Handle` object provides the component's interface to the framework.

## `handle.update(task?)`

Schedules a component update. Optionally accepts a task to run after the update
completes.

```tsx
function Counter(handle: Handle) {
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
			Count: {count}
		</button>
	)
}
```

With a task:

```tsx
function Player(handle: Handle) {
	let isPlaying = false
	let stopButton: HTMLButtonElement

	return () => (
		<button
			on={{
				click() {
					isPlaying = true
					handle.update(() => {
						// Task runs after update completes
						stopButton.focus()
					})
				},
			}}
		>
			Play
		</button>
	)
}
```

## `handle.queueTask(task)`

Schedules a task to run after the next update. The task receives an
`AbortSignal` that's aborted when:

- The component re-renders (new render cycle starts)
- The component is removed from the tree

Use `queueTask` in event handlers when work needs to happen after DOM changes:

```tsx
function Form(handle: Handle) {
	let showDetails = false
	let detailsSection: HTMLElement

	return () => (
		<div>
			<button
				on={{
					click() {
						showDetails = true
						handle.update()
						handle.queueTask(() => {
							detailsSection.scrollIntoView({ behavior: 'smooth' })
						})
					},
				}}
			>
				Show Details
			</button>
			{showDetails && (
				<div connect={(node) => (detailsSection = node)}>Details content</div>
			)}
		</div>
	)
}
```

Use `queueTask` for work that needs to be reactive to prop changes:

When you need to perform async work (like data fetching) that should respond to
prop changes, use `queueTask` in the render function. The signal will be aborted
if props change or the component is removed, ensuring only the latest work
completes.

### Anti-patterns

Do not create state just to react to it in `queueTask`:

```tsx
// BAD: Creating state just to react to it in queueTask
function BadExample(handle: Handle) {
	let shouldLoad = false // Unnecessary state

	return () => (
		<button
			on={{
				click() {
					shouldLoad = true
					handle.update()
					handle.queueTask(() => {
						if (shouldLoad) {
							// Do work
						}
					})
				},
			}}
		>
			Load
		</button>
	)
}

// GOOD: Do the work directly in the event handler or queueTask
function GoodExample(handle: Handle) {
	return () => (
		<button
			on={{
				click() {
					handle.queueTask(() => {
						// Do work directly - no intermediate state needed
					})
				},
			}}
		>
			Load
		</button>
	)
}
```

Do not call `handle.update()` before async work in a task:

```tsx
// BAD: Calling handle.update() before async work
function BadAsyncExample(handle: Handle) {
	let data: string[] = []
	let loading = false

	handle.queueTask(async (signal) => {
		loading = true
		handle.update() // This triggers a re-render, which aborts signal!

		let response = await fetch('/api/data', { signal }) // AbortError: signal is aborted
		if (signal.aborted) return

		data = await response.json()
		loading = false
		handle.update()
	})

	return () => <div>{loading ? 'Loading...' : data.join(', ')}</div>
}

// GOOD: Set initial state in setup, only call handle.update() after async work
function GoodAsyncExample(handle: Handle) {
	let data: string[] = []
	let loading = true // Start in loading state

	handle.queueTask(async (signal) => {
		let response = await fetch('/api/data', { signal })
		if (signal.aborted) return

		data = await response.json()
		loading = false
		handle.update() // Safe - async work is complete
	})

	return () => <div>{loading ? 'Loading...' : data.join(', ')}</div>
}
```

## Navigation

- [Handle signals and listeners](./handle-signals.md)
- [Handle context](./handle-context.md)
- [Component index](./index.md)
