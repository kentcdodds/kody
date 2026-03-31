# Composition keys

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/composition.md

## Key prop

Use the `key` prop to uniquely identify elements in lists. Keys enable efficient
diffing and preserve DOM nodes and component state when lists are reordered,
filtered, or updated.

```tsx
function TodoList(handle: Handle) {
	let todos = [
		{ id: '1', text: 'Buy milk' },
		{ id: '2', text: 'Walk dog' },
		{ id: '3', text: 'Write code' },
	]

	return () => (
		<ul>
			{todos.map((todo) => (
				<li key={todo.id}>{todo.text}</li>
			))}
		</ul>
	)
}
```

When you reorder, add, or remove items, keys ensure:

- **DOM nodes are reused** - Elements with matching keys are moved, not
  recreated
- **Component state is preserved** - Component instances persist across reorders
- **Focus and selection are maintained** - Input focus stays with the same
  element
- **Input values are preserved** - Form values remain with their elements

```tsx
function ReorderableList(handle: Handle) {
	let items = [
		{ id: 'a', label: 'Item A' },
		{ id: 'b', label: 'Item B' },
		{ id: 'c', label: 'Item C' },
	]

	function reverse() {
		items = [...items].reverse()
		handle.update()
	}

	return () => (
		<div>
			<button on={{ click: reverse }}>Reverse List</button>
			<ul>
				{items.map((item) => (
					<li key={item.id}>
						<input defaultValue={item.label} />
					</li>
				))}
			</ul>
		</div>
	)
}
```

Even when the list order changes, each input maintains its value and focus state
because the `key` prop identifies which DOM node corresponds to which item.

Keys can be any type (string, number, bigint, object, symbol), but should be
stable and unique within the list:

```tsx
// Good: stable, unique IDs
{
	items.map((item) => <div key={item.id} />)
}

// Good: index can work if list never reorders
{
	items.map((item, index) => <div key={index} />)
}

// Bad: don't use random values or values that change
{
	items.map((item) => <div key={Math.random()} />)
}
```

## See also

- [Context](./context.md) - Indirect composition without prop drilling
- [Animate basics](./animate-basics.md) - Keys are required for reclamation

## Navigation

- [Composition basics](./composition-basics.md)
- [Component index](./index.md)
- [Remix package index](../index.md)
