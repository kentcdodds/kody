# Context

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/context.md

Context enables components to communicate without direct prop passing.

## Basic context

Use `handle.context.set()` to provide values and `handle.context.get()` to
consume them:

```tsx
function ThemeProvider(handle: Handle<{ theme: 'light' | 'dark' }>) {
	let theme: 'light' | 'dark' = 'light'

	handle.context.set({ theme })

	return (props: { children: RemixNode }) => (
		<div>
			<button
				on={{
					click() {
						theme = theme === 'light' ? 'dark' : 'light'
						handle.context.set({ theme })
						handle.update()
					},
				}}
			>
				Toggle Theme
			</button>
			{props.children}
		</div>
	)
}

function ThemedContent(handle: Handle) {
	let { theme } = handle.context.get(ThemeProvider)

	return () => <div>Current theme: {theme}</div>
}
```

**Important:** `handle.context.set()` does not cause any updates - it simply
stores a value. If you want the component tree to update when context changes,
you must call `handle.update()` after setting the context (as shown above).

## TypedEventTarget for granular updates

For better performance, use `TypedEventTarget` to avoid updating the entire
subtree. This allows descendants to subscribe to specific changes rather than
re-rendering on every parent update:

```tsx
import { TypedEventTarget } from '@remix-run/interaction'

class Theme extends TypedEventTarget<{ change: Event }> {
	#value: 'light' | 'dark' = 'light'

	get value() {
		return this.#value
	}

	setValue(value: 'light' | 'dark') {
		this.#value = value
		this.dispatchEvent(new Event('change'))
	}
}

function ThemeProvider(handle: Handle) {
	let theme = new Theme()
	handle.context.set(theme)

	return (props: { children: RemixNode }) => (
		<div>
			<button
				on={{
					click() {
						theme.setValue(theme.value === 'light' ? 'dark' : 'light')
					},
				}}
			>
				Toggle Theme
			</button>
			{props.children}
		</div>
	)
}

function ThemedContent(handle: Handle) {
	let theme = handle.context.get(ThemeProvider)

	// Subscribe to granular updates
	handle.on(theme, {
		change() {
			handle.update()
		},
	})

	return () => <div>Current theme: {theme.value}</div>
}
```

Benefits of this pattern:

- **No unnecessary re-renders**: Only components that subscribe to changes are
  updated
- **Decoupled updates**: The provider doesn't need to call `handle.update()`
  when context changes
- **Type-safe events**: `TypedEventTarget` ensures event handlers receive the
  correct event types

## Context with multiple values

Provide multiple related values through context:

```tsx
class AppContext extends TypedEventTarget<{
	userChange: Event
	settingsChange: Event
}> {
	#user: User | null = null
	#settings: Settings = defaultSettings

	get user() {
		return this.#user
	}

	get settings() {
		return this.#settings
	}

	setUser(user: User | null) {
		this.#user = user
		this.dispatchEvent(new Event('userChange'))
	}

	setSettings(settings: Settings) {
		this.#settings = settings
		this.dispatchEvent(new Event('settingsChange'))
	}
}

function AppProvider(handle: Handle) {
	let context = new AppContext()
	handle.context.set(context)

	return (props: { children: RemixNode }) => props.children
}

// Components can subscribe to only the events they care about
function UserDisplay(handle: Handle) {
	let context = handle.context.get(AppProvider)

	handle.on(context, {
		userChange() {
			handle.update()
		},
	})

	return () => <div>{context.user?.name ?? 'Not logged in'}</div>
}
```

## See also

- [Handle context](./handle-context.md) - `handle.context` reference
- [Events](./events-basics.md) - `handle.on()` for subscribing to EventTargets

## Navigation

- [Component index](./index.md)
- [Remix package index](../index.md)
