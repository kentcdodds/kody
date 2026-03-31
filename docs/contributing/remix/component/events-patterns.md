# Event patterns

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/events.md

## Multiple event types

Handle multiple events on the same element:

```tsx
function InteractiveBox(handle: Handle) {
	let state = 'idle'

	return () => (
		<div
			on={{
				mouseenter() {
					state = 'hovered'
					handle.update()
				},
				mouseleave() {
					state = 'idle'
					handle.update()
				},
				click() {
					state = 'clicked'
					handle.update()
				},
			}}
		>
			State: {state}
		</div>
	)
}
```

## Form events

Common form event patterns:

```tsx
function Form(handle: Handle) {
	return () => (
		<form
			on={{
				submit(event) {
					event.preventDefault()
					let formData = new FormData(event.currentTarget)
					// Process form data
				},
			}}
		>
			<input
				name="email"
				on={{
					blur(event) {
						// Validate on blur
						let value = event.currentTarget.value
						if (!value.includes('@')) {
							event.currentTarget.setCustomValidity('Invalid email')
						}
					},
					input(event) {
						// Clear validation on input
						event.currentTarget.setCustomValidity('')
					},
				}}
			/>
			<button type="submit">Submit</button>
		</form>
	)
}
```

## Keyboard events

Handle keyboard interactions:

```tsx
function KeyboardNav(handle: Handle) {
	let selectedIndex = 0
	let items = ['Apple', 'Banana', 'Cherry']

	return () => (
		<ul
			tabIndex={0}
			on={{
				keydown(event) {
					switch (event.key) {
						case 'ArrowDown':
							event.preventDefault()
							selectedIndex = Math.min(selectedIndex + 1, items.length - 1)
							handle.update()
							break
						case 'ArrowUp':
							event.preventDefault()
							selectedIndex = Math.max(selectedIndex - 1, 0)
							handle.update()
							break
					}
				},
			}}
		>
			{items.map((item, i) => (
				<li
					key={i}
					css={{
						backgroundColor: i === selectedIndex ? '#eee' : 'transparent',
					}}
				>
					{item}
				</li>
			))}
		</ul>
	)
}
```

## Global event listeners

Use `handle.on()` for global event targets with automatic cleanup:

```tsx
function WindowResizeTracker(handle: Handle) {
	let width = window.innerWidth
	let height = window.innerHeight

	// Set up global listeners once in setup
	handle.on(window, {
		resize() {
			width = window.innerWidth
			height = window.innerHeight
			handle.update()
		},
	})

	return () => (
		<div>
			Window size: {width} x {height}
		</div>
	)
}
```

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

## Navigation

- [Event handling basics](./events-basics.md)
- [Event best practices](./events-best-practices.md)
- [Component index](./index.md)
