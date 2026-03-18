# Handle context

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/handle.md

## `handle.context`

Context API for ancestor/descendant communication. See `context.md` for full
documentation.

```tsx
function App(handle: Handle<{ theme: string }>) {
	handle.context.set({ theme: 'dark' })

	return () => (
		<div>
			<Header />
		</div>
	)
}

function Header(handle: Handle) {
	let { theme } = handle.context.get(App)
	return () => <div>Header</div>
}
```

**Important:** `handle.context.set()` does not cause any updates - it simply
stores a value. If you need the component tree to update when context changes,
call `handle.update()` after setting the context.

## See also

- [Events](./events-basics.md) - Event handling patterns with signals
- [Context](./context.md) - Context API with TypedEventTarget
- [Patterns](./patterns-state.md) - Common usage patterns

## Navigation

- [Handle updates and tasks](./handle-updates.md)
- [Component index](./index.md)
