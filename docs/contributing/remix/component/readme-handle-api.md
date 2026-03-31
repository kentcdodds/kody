# Component README: handle API

Source: https://github.com/remix-run/remix/tree/main/packages/component

## Component Handle API

Components receive a `Handle` as their first argument with the following API:

- **`handle.update(task?)`** - Schedule an update. Optionally provide a task to
  run after the update.
- **`handle.queueTask(task)`** - Schedule a task to run after the next update.
  Useful for DOM operations that need to happen after rendering.
- **`handle.on(target, listeners)`** - Listen to an event target with automatic
  cleanup when the component disconnects.
- **`handle.signal`** - An `AbortSignal` that's aborted when the component is
  disconnected. Useful for cleanup.
- **`handle.id`** - Stable identifier per component instance.
- **`handle.context`** - Context API for ancestor/descendant communication.

### `handle.update(task?)`

Schedule an update. Optionally provide a task to run after the update completes.

```tsx
function Counter(handle: Handle) {
	let count = 0

	return () => (
		<button
			on={{
				click: () => {
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

You can pass a task to run after the update:

```tsx
function Player(handle: Handle) {
	let isPlaying = false
	let playButton: HTMLButtonElement
	let stopButton: HTMLButtonElement

	return () => (
		<div>
			<button
				disabled={isPlaying}
				connect={(node) => (playButton = node)}
				on={{
					click: () => {
						isPlaying = true
						handle.update(() => {
							// Focus the enabled button after update completes
							stopButton.focus()
						})
					},
				}}
			>
				Play
			</button>
			<button
				disabled={!isPlaying}
				connect={(node) => (stopButton = node)}
				on={{
					click: () => {
						isPlaying = false
						handle.update(() => {
							// Focus the enabled button after update completes
							playButton.focus()
						})
					},
				}}
			>
				Stop
			</button>
		</div>
	)
}
```

### `handle.queueTask(task)`

Schedule a task to run after the next update. Useful for DOM operations that
need to happen after rendering.

```tsx
function Form(handle: Handle) {
	let showDetails = false
	let detailsSection: HTMLElement

	return () => (
		<form>
			<label>
				<input
					type="checkbox"
					checked={showDetails}
					on={{
						change: (event) => {
							showDetails = event.currentTarget.checked
							handle.update()
							if (showDetails) {
								// Scroll to the expanded section after it renders
								handle.queueTask(() => {
									detailsSection.scrollIntoView({
										behavior: 'smooth',
										block: 'start',
									})
								})
							}
						},
					}}
				/>
				Show additional details
			</label>
			{showDetails && (
				<section
					connect={(node) => (detailsSection = node)}
					css={{
						marginTop: '2rem',
						padding: '1rem',
						border: '1px solid #ccc',
					}}
				>
					<h2>Additional Details</h2>
					<p>This section appears when the checkbox is checked.</p>
				</section>
			)}
		</form>
	)
}
```

## Navigation

- [Handle listeners and signals](./readme-handle-listeners.md)
- [Handle context](./readme-handle-context.md)
- [Fragments and future work](./readme-extras.md)
- [Component index](./index.md)
