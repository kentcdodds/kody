# Component README: state and setup

Source: https://github.com/remix-run/remix/tree/main/packages/component

## Component state and updates

State is managed with plain JavaScript variables. Call `handle.update()` to
schedule an update:

```tsx
function Counter(handle: Handle) {
	let count = 0

	return () => (
		<div>
			<span>Count: {count}</span>
			<button
				on={{
					click: () => {
						count++
						handle.update()
					},
				}}
			>
				Increment
			</button>
		</div>
	)
}
```

## Components

All components return a render function. The setup function runs once when the
component is first created, and the returned render function runs on the first
render and every update afterward:

```tsx
function Counter(handle: Handle, setup: number) {
	// Setup phase: runs once
	let count = setup

	// Return render function: runs on every update
	return (props: { label?: string }) => (
		<div>
			{props.label || 'Count'}: {count}
			<button
				on={{
					click: () => {
						count++
						handle.update()
					},
				}}
			>
				Increment
			</button>
		</div>
	)
}
```

### Setup prop vs props

When a component returns a function, it has two phases:

1. **Setup phase** - The component function receives the `setup` prop and runs
   once. Use this for initialization.
2. **Render phase** - The returned function receives props and runs on initial
   render and every update afterward. Use this for rendering.

The `setup` prop is separate from regular props. Only the `setup` prop is passed
to the setup function, and only props are passed to the render function.

- `setup` prop for values that initialize state (e.g., `initial`,
  `defaultValue`)
- Regular props for values that change over time (e.g., `label`, `disabled`)

```tsx
// Usage: setup prop goes to setup function, regular props go to render function
let el = <Counter setup={5} label="Total" />

function Counter(
	handle: Handle,
	setup: number, // receives 5 (the setup prop value)
) {
	let count = setup // use setup for initialization

	return (props: { label?: string }) => {
		// props only receives { label: "Total" } - not the setup prop
		return (
			<div>
				{props.label}: {count}
			</div>
		)
	}
}
```

## Navigation

- [README overview](./readme-overview.md)
- [Events](./readme-events.md)
- [Component index](./index.md)
