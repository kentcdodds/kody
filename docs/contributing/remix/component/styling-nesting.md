# Styling with nested selectors

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/styling.md

## When to use nested selectors

Use nested selectors when parent state affects children. Do not nest when you
can style the element directly.

This is preferable to creating JavaScript state and passing it around. Instead
of managing hover/focus state in JavaScript and passing it as props, use CSS
nested selectors to let the browser handle state transitions declaratively.

Use nested selectors when:

1. Parent state affects children - Parent hover/focus/state changes child
   styling (prefer this over JavaScript state management)
2. Styling descendant elements - Avoid duplicating styles on every child or
   creating new components just for styling

Do not nest when:

- Styling the element's own pseudo-states (hover, focus, etc.)
- The element controls its own styling

Example: Parent hover affects children (use nested selectors, not JavaScript
state):

```tsx
// BAD: Managing hover state in JavaScript
function CardWithJSState(handle: Handle) {
	let isHovered = false

	return (props: { children: RemixNode }) => (
		<div
			on={{
				mouseenter() {
					isHovered = true
					handle.update()
				},
				mouseleave() {
					isHovered = false
					handle.update()
				},
			}}
			css={{
				border: '1px solid #ddd',
			}}
		>
			<div
				style={{
					color: isHovered ? '#333' : '#888',
				}}
			>
				Title
			</div>
			{props.children}
		</div>
	)
}

// GOOD: CSS nested selectors handle state declaratively
function Card(handle: Handle) {
	return (props: { children: RemixNode }) => (
		<div
			css={{
				border: '1px solid #ddd',
				'&:hover .title': {
					color: '#333',
				},
			}}
		>
			<div className="title">Title</div>
			{props.children}
		</div>
	)
}
```

Example: Element's own hover (style directly, no nesting needed):

```tsx
function Button() {
	return () => (
		<button
			css={{
				backgroundColor: '#444',
				color: 'white',
				'&:hover': {
					backgroundColor: '#555',
				},
			}}
		>
			Hover me
		</button>
	)
}
```

## Navigation

- [Styling selectors](./styling-selectors.md)
- [Styling responsive and examples](./styling-responsive.md)
- [Component index](./index.md)
