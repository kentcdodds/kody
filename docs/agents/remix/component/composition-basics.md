# Composition basics

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/composition.md

Building component trees with props, children, and `connect`.

## Props

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

## Children

Components can compose other components via `children`:

```tsx
function Layout() {
	return (props: { children: RemixNode }) => (
		<div>
			<header>My App</header>
			<main>{props.children}</main>
			<footer>(c) 2024</footer>
		</div>
	)
}

function App() {
	return () => (
		<Layout>
			<h1>Welcome</h1>
			<p>Content goes here</p>
		</Layout>
	)
}
```

## Connect prop

Use the `connect` prop to get a reference to the DOM node after it's rendered.
This is useful for DOM operations like focusing elements, scrolling, measuring
dimensions, or setting up observers.

```tsx
function Form(handle: Handle) {
	let inputRef: HTMLInputElement

	return () => (
		<form>
			<input connect={(node) => (inputRef = node)} />
			<button
				on={{
					click(event) {
						event.preventDefault()
						inputRef.focus()
					},
				}}
			>
				Focus Input
			</button>
		</form>
	)
}
```

The `connect` callback can optionally receive an `AbortSignal` as a second
parameter, which is aborted when the element is removed from the DOM. Use this
for cleanup operations:

```tsx
function ResizeTracker(handle: Handle) {
	let dimensions = { width: 0, height: 0 }

	return () => (
		<div
			connect={(node, signal) => {
				// Set up ResizeObserver
				let observer = new ResizeObserver((entries) => {
					let entry = entries[0]
					if (entry) {
						dimensions.width = Math.round(entry.contentRect.width)
						dimensions.height = Math.round(entry.contentRect.height)
						handle.update()
					}
				})
				observer.observe(node)

				// Clean up when element is removed
				signal.addEventListener('abort', () => {
					observer.disconnect()
				})
			}}
		>
			Size: {dimensions.width} x {dimensions.height}
		</div>
	)
}
```

The `connect` callback is called only once when the element is first rendered,
not on every update.

## Navigation

- [Composition keys](./composition-keys.md)
- [Component index](./index.md)
- [Remix package index](../index.md)
