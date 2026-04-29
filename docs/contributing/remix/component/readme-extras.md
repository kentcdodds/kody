# Component README: extras

Source: https://github.com/remix-run/remix/tree/main/packages/component

## Fragments

Use `Fragment` to group elements without adding extra DOM nodes:

```tsx
function List(handle: Handle) {
	return () => (
		<>
			<li>Item 1</li>
			<li>Item 2</li>
			<li>Item 3</li>
		</>
	)
}
```

## Wrapping components

- use `Props<'div'>`
- use `RemixNode` not JSX.Element, etc.

## Additional notes

This package documentation also mentions features demo'd at Remix Jam,
including:

- Server Rendering
- Selective Hydration
- `<Frame>` for streamable, reloadable partial server UI

See [LICENSE](https://github.com/remix-run/remix/blob/main/LICENSE)

## Navigation

- [Handle context](./readme-handle-context.md)
- [Component index](./index.md)
