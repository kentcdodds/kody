# Styling responsive and examples

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/styling.md

## Media queries

Use `@media` for responsive design:

```tsx
function ResponsiveGrid() {
	return (props: { children: RemixNode }) => (
		<div
			css={{
				display: 'grid',
				gap: 12,
				gridTemplateColumns: 'repeat(4, 1fr)',
				'@media (max-width: 900px)': {
					gridTemplateColumns: 'repeat(2, 1fr)',
				},
				'@media (max-width: 600px)': {
					gridTemplateColumns: 'repeat(1, 1fr)',
				},
			}}
		>
			{props.children}
		</div>
	)
}
```

## Complete example

Here's a comprehensive example demonstrating parent-state-affecting-children and
media queries:

```tsx
function ProductCard() {
	return (props: { title: string; price: number; image: string }) => (
		<div
			css={{
				border: '1px solid #eee',
				borderRadius: 8,
				overflow: 'hidden',
				'&:hover .title': {
					color: '#333',
				},
			}}
		>
			<img src={props.image} alt={props.title} />
			<div css={{ padding: 12 }}>
				<div className="title" css={{ fontSize: 18, fontWeight: 600 }}>
					{props.title}
				</div>
				<div css={{ color: '#666' }}>${props.price}</div>
				<button
					css={{
						marginTop: 8,
						backgroundColor: '#111',
						color: 'white',
						padding: '6px 10px',
						'&:active': {
							transform: 'scale(0.98)',
						},
						'@media (max-width: 600px)': {
							width: '100%',
						},
					}}
				>
					Add to Cart
				</button>
			</div>
		</div>
	)
}
```

This example demonstrates:

- Parent hover affecting children: Card hover changes title color and button
  background
- Styles on elements themselves: Each element has its own `css` prop
- Element's own states: Button's `:active` state styled directly on the button
- Media queries: Responsive adjustments applied directly to elements

## See also

- [Spring basics](./spring-basics.md) - Physics-based animation easing
- [Animate basics](./animate-basics.md) - Declarative animations

## Navigation

- [Styling selectors](./styling-selectors.md)
- [Component index](./index.md)
