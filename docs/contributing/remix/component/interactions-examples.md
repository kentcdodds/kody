# Interaction examples

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/interactions.md

## Consuming in components

Use custom interactions just like built-in events:

```tsx
import { dragRelease } from './drag-release.ts'

function DraggableCard(handle: Handle) {
	return () => (
		<div
			on={{
				[dragRelease]() {
					/* ... */
				},
			}}
		>
			Drag me
		</div>
	)
}
```

## Example: tap tempo

A more complex example that tracks repeated taps to calculate BPM:

```ts
import { defineInteraction, type Interaction } from '@remix-run/interaction'

export let tempo = defineInteraction('myapp:tempo', Tempo)

declare global {
	interface HTMLElementEventMap {
		[tempo]: TempoEvent
	}
}

export class TempoEvent extends Event {
	bpm: number

	constructor(type: typeof tempo, bpm: number) {
		super(type)
		this.bpm = bpm
	}
}

function Tempo(handle: Interaction) {
	if (!(handle.target instanceof HTMLElement)) return

	let target = handle.target
	let taps: number[] = []
	let resetTimer = 0

	function handleTap() {
		clearTimeout(resetTimer)

		taps.push(Date.now())
		taps = taps.filter((tap) => Date.now() - tap < 4000)

		if (taps.length >= 4) {
			let intervals = []
			for (let i = 1; i < taps.length; i++) {
				intervals.push(taps[i] - taps[i - 1])
			}
			let avgMs = intervals.reduce((sum, v) => sum + v, 0) / intervals.length
			let bpm = Math.round(60000 / avgMs)
			target.dispatchEvent(new TempoEvent(tempo, bpm))
		}

		resetTimer = window.setTimeout(() => {
			taps = []
		}, 4000)
	}

	handle.on(target, {
		pointerdown: handleTap,
		keydown(event) {
			if (event.repeat) return
			if (event.key === 'Enter' || event.key === ' ') {
				handleTap()
			}
		},
	})
}
```

## Best practices

1. **Namespace your event types** - Use a prefix like `myapp:` to avoid
   collisions with built-in interactions
2. **Use cancelable events** - Set `cancelable: true` so consumers can call
   `event.preventDefault()`
3. **Include relevant data** - Add properties to your event class for data
   consumers need
4. **Guard element types** - Check `handle.target instanceof HTMLElement` if you
   need DOM-specific APIs
5. **Clean up automatically** - Use `handle.on()` instead of `addEventListener`
   for automatic cleanup

## See also

- [Events](./events-basics.md) - Event handling basics
- [Handle updates and tasks](./handle-updates.md) - `handle.on()` in components

## Navigation

- [Interaction basics](./interactions-basics.md)
- [Component index](./index.md)
