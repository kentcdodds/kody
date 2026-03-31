# Pattern: focus and scroll

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/patterns.md

Use `handle.queueTask()` in event handlers for DOM operations that need to
happen after the DOM has changed from the next update.

## Focus management

```tsx
function Modal(handle: Handle) {
	let isOpen = false
	let closeButton: HTMLButtonElement
	let openButton: HTMLButtonElement

	return () => (
		<div>
			<button
				connect={(node) => (openButton = node)}
				on={{
					click() {
						isOpen = true
						handle.update()
						// Queue focus operation after modal renders
						handle.queueTask(() => {
							closeButton.focus()
						})
					},
				}}
			>
				Open Modal
			</button>

			{isOpen && (
				<div>
					<button
						connect={(node) => (closeButton = node)}
						on={{
							click() {
								isOpen = false
								handle.update()
								// Queue focus operation after modal closes
								handle.queueTask(() => {
									openButton.focus()
								})
							},
						}}
					>
						Close
					</button>
				</div>
			)}
		</div>
	)
}
```

## Scroll management

```tsx
function ScrollableList(handle: Handle) {
	let items: string[] = []
	let newItemInput: HTMLInputElement
	let listContainer: HTMLElement

	return () => (
		<div>
			<input
				connect={(node) => (newItemInput = node)}
				on={{
					keydown(event) {
						if (event.key === 'Enter') {
							let text = event.currentTarget.value
							if (text.trim()) {
								items.push(text)
								event.currentTarget.value = ''
								handle.update()
								// Queue scroll operation after new item renders
								handle.queueTask(() => {
									listContainer.scrollTop = listContainer.scrollHeight
								})
							}
						}
					},
				}}
			/>
			<div
				connect={(node) => (listContainer = node)}
				css={{
					maxHeight: '300px',
					overflowY: 'auto',
				}}
			>
				{items.map((item, i) => (
					<div key={i}>{item}</div>
				))}
			</div>
		</div>
	)
}
```

## Navigation

- [Pattern: inputs](./patterns-inputs.md)
- [Component index](./index.md)
