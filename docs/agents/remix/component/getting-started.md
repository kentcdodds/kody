# Getting started

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/getting-started.md

Create interactive UIs with Remix Component using a two-phase component model:
setup runs once, render runs on every update.

## Creating a root

To start using Remix Component, create a root and render your top-level
component:

```tsx
import { createRoot } from '@remix-run/component'
import type { Handle } from '@remix-run/component'

function App(handle: Handle) {
	return () => <div>Hello, World!</div>
}

// Create a root attached to a DOM element
let container = document.getElementById('app')!
let root = createRoot(container)

// Render your app
root.render(<App />)
```

The `createRoot` function takes a DOM element (or `document.body`) and returns a
root object with a `render` method. You can call `render` multiple times to
update the app:

```tsx
function App(handle: Handle) {
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

let root = createRoot(document.body)
root.render(<App />)

// Later, you can update the app by calling render again
// root.render(<App />)
```

## Root methods

The root object provides several methods:

- **`render(node)`** - Renders a component tree into the root container
- **`flush()`** - Synchronously flushes all pending updates and tasks
- **`remove()`** - Removes the component tree and cleans up

```tsx
let root = createRoot(document.body)

// Render initial app
root.render(<App />)

// Flush any pending updates synchronously
root.flush()

// Later, remove the app
root.remove()
```

## Next steps

- [Components](./components.md) - Component structure and runtime behavior
- [Handle API](./handle-updates.md) - The component's interface to the framework
- [Styling](./styling-basics.md) - CSS prop for inline styling
- [Events](./events-basics.md) - Event handling patterns

## Navigation

- [Component index](./index.md)
- [Remix package index](../index.md)
