# Component README: styling and connect

Source: https://github.com/remix-run/remix/tree/main/packages/component

## CSS prop

Use the `css` prop for inline styles with pseudo-selectors and nested rules:

```tsx
function Button(handle: Handle) {
	return () => (
		<button
			css={{
				color: 'white',
				backgroundColor: 'blue',
				'&:hover': {
					backgroundColor: 'darkblue',
				},
				'&:active': {
					transform: 'scale(0.98)',
				},
			}}
		>
			Click me
		</button>
	)
}
```

The syntax mirrors modern CSS nesting, but in object form. Use `&` to reference
the current element in pseudo-selectors, pseudo-elements, and attribute
selectors. Use class names or other selectors directly for child selectors:

```css
.button {
	color: white;
	background-color: blue;

	&:hover {
		background-color: darkblue;
	}

	&::before {
		content: '';
		position: absolute;
	}

	&[aria-selected='true'] {
		border: 2px solid yellow;
	}

	.icon {
		width: 16px;
		height: 16px;
	}

	@media (max-width: 768px) {
		padding: 8px;
	}
}
```

```tsx
function Button(handle: Handle) {
	return () => (
		<button
			css={{
				color: 'white',
				backgroundColor: 'blue',
				'&:hover': {
					backgroundColor: 'darkblue',
				},
				'&::before': {
					content: '""',
					position: 'absolute',
				},
				'&[aria-selected="true"]': {
					border: '2px solid yellow',
				},
				'.icon': {
					width: '16px',
					height: '16px',
				},
				'@media (max-width: 768px)': {
					padding: '8px',
				},
			}}
		>
			<span className="icon">*</span>
			Click me
		</button>
	)
}
```

## Connect prop

Use the `connect` prop to get a reference to the DOM node after it's rendered.
This is useful for DOM operations like focusing elements, scrolling, or
measuring dimensions.

```tsx
function Form(handle: Handle) {
	let inputRef: HTMLInputElement

	return () => (
		<form>
			<input
				type="text"
				// get the input node
				connect={(node) => (inputRef = node)}
			/>
			<button
				on={{
					click: () => {
						// Select it from other parts of the form
						inputRef.select()
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
parameter, which is aborted when the element is removed from the DOM:

```tsx
function Component(handle: Handle) {
	return () => (
		<div
			connect={(node, signal) => {
				// Set up something that needs cleanup
				let observer = new ResizeObserver(() => {
					// handle resize
				})
				observer.observe(node)

				// Clean up when element is removed
				signal.addEventListener('abort', () => {
					observer.disconnect()
				})
			}}
		>
			Content
		</div>
	)
}
```

## Navigation

- [Component state and setup props](./readme-components.md)
- [Handle API reference](./readme-handle-api.md)
- [Component index](./index.md)
