# Styling selectors

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/styling.md

## Pseudo-selectors

Use `&` to reference the current element in pseudo-selectors:

```tsx
function Button() {
	return () => (
		<button
			css={{
				backgroundColor: '#333',
				color: 'white',
				'&:hover': {
					backgroundColor: '#444',
				},
				'&:focus': {
					outline: '2px solid #66f',
				},
			}}
		>
			Click me
		</button>
	)
}
```

## Pseudo-elements

Use `&::before` and `&::after` for pseudo-elements:

```tsx
function Badge() {
	return (props: { count: number }) => (
		<div
			css={{
				position: 'relative',
				padding: '4px 8px',
				'&::after': {
					content: `"${props.count}"`,
					position: 'absolute',
					top: -4,
					right: -4,
					backgroundColor: 'red',
					color: 'white',
					borderRadius: 999,
					padding: '2px 6px',
					fontSize: 10,
				},
			}}
		>
			Notifications
		</div>
	)
}
```

## Attribute selectors

Use `&[attribute]` for attribute selectors:

```tsx
function Input() {
	return (props: { required?: boolean }) => (
		<input
			required={props.required}
			css={{
				border: '1px solid #ccc',
				'&[required]': {
					borderColor: 'red',
				},
			}}
		/>
	)
}
```

## Descendant selectors

Use class names or element selectors directly for descendant selectors:

```tsx
function Card() {
	return (props: { children: RemixNode }) => (
		<div
			css={{
				padding: 16,
				border: '1px solid #ddd',
				'.title': {
					fontWeight: 600,
				},
				p: {
					margin: 0,
				},
			}}
		>
			<div className="title">Title</div>
			{props.children}
		</div>
	)
}
```

## Navigation

- [Styling basics](./styling-basics.md)
- [Styling with nested selectors](./styling-nesting.md)
- [Styling responsive and examples](./styling-responsive.md)
- [Component index](./index.md)
