# Components

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/components.md

All components follow a consistent two-phase structure.

## Component structure

1. **Setup phase** - Runs once when the component is first created
2. **Render phase** - Runs on initial render and every update afterward

```tsx
function MyComponent(handle: Handle, setup: SetupType) {
	// Setup phase: runs once
	let state = initializeState(setup)

	// Return render function: runs on every update
	return (props: Props) => {
		return <div>{/* render content */}</div>
	}
}
```

## Runtime behavior

When a component is rendered:

1. **First render**:

- The component function is called with `handle` and the `setup` prop
- The returned render function is stored
- The render function is called with regular props
- Any tasks queued via `handle.queueTask()` are executed after rendering

2. **Subsequent updates**:

- Only the render function is called
- Setup phase is skipped, setup closure persists for the lifetime of the
  component instance
- Props are passed to the render function
- The `setup` prop is stripped from props
- Tasks queued during the update are executed after rendering

3. **Component removal**:

- `handle.signal` is aborted
- All event listeners registered via `handle.on()` are automatically cleaned up
- Any queued tasks are executed with an aborted signal

## Setup vs props

The `setup` prop is special - it's only available in the setup phase and is
automatically excluded from props. This prevents accidental stale captures:

```tsx
function Counter(handle: Handle, setup: number) {
	// setup prop (e.g., initialCount) only available here
	let count = setup

	return (props: { label: string }) => {
		// props only receives { label } - setup is excluded
		return (
			<div>
				{props.label}: {count}
			</div>
		)
	}
}

// Usage
let element = <Counter setup={5} label="Clicks" />
```

## Basic rendering

The simplest component just returns JSX:

```tsx
function Greeting() {
	return (props: { name: string }) => <div>Hello, {props.name}!</div>
}

let el = <Greeting name="Remix" />
```

## Prop passing

Props flow from parent to child through JSX attributes:

```tsx
function Parent() {
	return () => <Child message="Hello" count={3} />
}

function Child() {
	return (props: { message: string; count: number }) => (
		<div>
			<div>{props.message}</div>
			<div>Count: {props.count}</div>
		</div>
	)
}
```

## Stateful updates

State is managed with plain JavaScript variables. Call `handle.update()` to
trigger a re-render:

```tsx
function Counter(handle: Handle) {
	let count = 0

	return () => (
		<div>
			<div>Count: {count}</div>
			<button
				on={{
					click() {
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

## See also

- [Handle API](./handle-updates.md) - Complete handle API reference
- [Patterns](./patterns-state.md) - State management best practices

## Navigation

- [Component index](./index.md)
- [Remix package index](../index.md)
