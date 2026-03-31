# Component README: handle context

Source: https://github.com/remix-run/remix/tree/main/packages/component

## `handle.context`

Context API for ancestor/descendant communication. All components are potential
context providers and consumers. Use `handle.context.set()` to provide values
and `handle.context.get()` to consume them.

```tsx
function App(handle: Handle<{ theme: string }>) {
	handle.context.set({ theme: 'dark' })

	return () => (
		<div>
			<Header />
			<Content />
		</div>
	)
}

function Header(handle: Handle) {
	// Consume context from App
	let { theme } = handle.context.get(App)
	return () => (
		<header
			css={{
				backgroundColor: theme === 'dark' ? '#000' : '#fff',
			}}
		>
			Header
		</header>
	)
}
```

Setting context values does not automatically trigger updates. If a provider
needs to render its own context values, call `handle.update()` after setting
them. However, since providers often don't render context values themselves,
calling `update()` can cause expensive updates of the entire subtree. Instead,
make your context an
[EventTarget](https://developer.mozilla.org/en-US/docs/Web/API/EventTarget) and
have consumers subscribe to changes.

```tsx
import { TypedEventTarget } from '@remix-run/interaction'

class Theme extends TypedEventTarget<{ change: Event }> {
	#value: 'light' | 'dark' = 'light'

	get value() {
		return this.#value
	}

	setValue(value: string) {
		this.#value = value
		this.dispatchEvent(new Event('change'))
	}
}

function App(handle: Handle<Theme>) {
	let theme = new Theme()
	handle.context.set(theme)

	return () => (
		<div>
			<button
				on={{
					click: () => {
						// no updates in the parent component
						theme.setValue(theme.value === 'light' ? 'dark' : 'light')
					},
				}}
			>
				Toggle Theme
			</button>
			<ThemedContent />
		</div>
	)
}

function ThemedContent(handle: Handle) {
	let theme = handle.context.get(App)

	// Subscribe to theme changes and update when it changes
	handle.on(theme, { change: () => handle.update() })

	return () => (
		<div css={{ backgroundColor: theme.value === 'dark' ? '#000' : '#fff' }}>
			Current theme: {theme.value}
		</div>
	)
}
```

## Navigation

- [Handle API reference](./readme-handle-api.md)
- [Fragments and future work](./readme-extras.md)
- [Component index](./index.md)
