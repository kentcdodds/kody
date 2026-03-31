# Testing

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/testing.md

Testing component behavior is just JavaScript. Use your favorite test runner.

## Example

```tsx
import { createRoot } from '@remix-run/component'

describe('Counter', () => {
	it('increments when clicked', () => {
		let container = document.createElement('div')
		let root = createRoot(container)
		root.render(<Counter />)

		let button = container.querySelector('button')!
		button.click()

		expect(button.textContent).toBe('Count: 1')
	})
})
```

## Testing async behavior

Use `AbortSignal` in event handlers to ensure predictable async behavior in
tests, just like in production.

```tsx
it('aborts stale async work', async () => {
	let signal: AbortSignal | undefined

	function Search(handle: Handle) {
		return () => (
			<input
				on={{
					async input(event, localSignal) {
						signal = localSignal
						await new Promise((resolve) => setTimeout(resolve, 10))
						if (signal?.aborted) return
					},
				}}
			/>
		)
	}

	// render, trigger input twice quickly...
})
```

## Navigation

- [Getting started](./getting-started.md)
- [Handle updates and tasks](./handle-updates.md)
- [Component index](./index.md)
