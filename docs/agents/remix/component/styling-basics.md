# Styling basics

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/styling.md

The `css` prop provides inline styling with support for pseudo-selectors,
pseudo-elements, attribute selectors, descendant selectors, and media queries.
It follows modern CSS nesting selector rules.

## Basic CSS prop

```tsx
function Button() {
	return () => (
		<button
			css={{
				backgroundColor: '#222',
				color: 'white',
				padding: '8px 12px',
				borderRadius: 6,
			}}
		>
			Click me
		</button>
	)
}
```

## CSS prop vs style prop

The `css` prop produces static styles that are inserted into the document as CSS
rules, while the `style` prop applies styles directly to the element. For
dynamic styles that change frequently, use the `style` prop for better
performance:

```tsx
// BAD: Using css prop for dynamic styles
function ProgressBar(handle: Handle) {
	let progress = 0

	return () => (
		<div
			css={{
				width: `${progress}%`,
				backgroundColor: 'green',
			}}
		>
			{progress}%
		</div>
	)
}

// GOOD: Using style prop for dynamic styles
function ProgressBar(handle: Handle) {
	let progress = 0

	return () => (
		<div
			style={{
				width: `${progress}%`,
				backgroundColor: 'green',
			}}
		>
			{progress}%
		</div>
	)
}
```

Use the `css` prop for:

- Static styles that don't change
- Styles that need pseudo-selectors (`:hover`, `:focus`, etc.)
- Styles that need media queries

Use the `style` prop for:

- Dynamic styles that change based on state or props
- Computed values that update frequently

## Navigation

- [Styling selectors](./styling-selectors.md)
- [Component index](./index.md)
