# Pattern: state management

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/patterns.md

Common patterns and best practices for building components.

## Use minimal component state

Only store state that's needed for rendering. Derive computed values instead of
storing them, and avoid storing input state that you don't need.

Derive computed values:

```tsx
// BAD: Storing computed values
function TodoList(handle: Handle) {
	let todos: string[] = []
	let completedCount = 0 // Unnecessary state

	return () => (
		<div>
			{todos.map((todo, i) => (
				<div key={i}>{todo}</div>
			))}
			<div>Completed: {completedCount}</div>
		</div>
	)
}

// GOOD: Derive computed values in render
function TodoList(handle: Handle) {
	let todos: Array<{ text: string; completed: boolean }> = []

	return () => {
		// Derive computed value in render
		let completedCount = todos.filter((t) => t.completed).length

		return (
			<div>
				{todos.map((todo, i) => (
					<div key={i}>{todo.text}</div>
				))}
				<div>Completed: {completedCount}</div>
			</div>
		)
	}
}
```

Do not store input state you do not need:

```tsx
// BAD: Storing input value when you only need it on submit
function SearchForm(handle: Handle) {
	let query = '' // Unnecessary state

	return () => (
		<form>
			<input
				value={query}
				on={{
					input(event) {
						query = event.currentTarget.value
						handle.update()
					},
				}}
			/>
			<button type="submit">Search</button>
		</form>
	)
}

// GOOD: Read input value directly from the form
function SearchForm(handle: Handle) {
	return () => (
		<form
			on={{
				submit(event) {
					event.preventDefault()
					let formData = new FormData(event.currentTarget)
					let query = formData.get('query')
				},
			}}
		>
			<input name="query" />
			<button type="submit">Search</button>
		</form>
	)
}
```

## Do work in event handlers

Do as much work as possible in event handlers with minimal component state. Use
the event handler scope for transient event state, and only capture to component
state if it's used for rendering.

```tsx
// GOOD: Store state that affects rendering
function Toggle(handle: Handle) {
	let isOpen = false // Needed for rendering conditional content

	return () => (
		<div>
			<button
				on={{
					click() {
						isOpen = !isOpen
						handle.update()
					},
				}}
			>
				Toggle
			</button>
			{isOpen && <div>Content</div>}
		</div>
	)
}
```

## Navigation

- [Pattern: setup scope](./patterns-setup.md)
- [Component index](./index.md)
