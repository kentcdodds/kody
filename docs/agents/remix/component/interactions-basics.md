# Interaction basics

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/interactions.md

Build reusable interaction patterns with the `@remix-run/interaction` package.

## Built-in interactions

The interaction package provides several ready-to-use interactions:

```tsx
import {
	press,
	pressDown,
	pressUp,
	longPress,
	pressCancel,
} from '@remix-run/interaction/press'
import {
	swipeStart,
	swipeMove,
	swipeEnd,
	swipeCancel,
} from '@remix-run/interaction/swipe'
import {
	arrowUp,
	arrowDown,
	arrowLeft,
	arrowRight,
	space,
} from '@remix-run/interaction/keys'
```

Use them like any event type:

```tsx
<button
	on={{
		[press]() {
			doAction()
		},
	}}
>
	Action
</button>
```

## When to create custom interactions

Create a custom interaction when:

- You need to combine multiple low-level events into a semantic action
- The interaction pattern will be reused across multiple components
- You want to encapsulate complex state tracking (e.g., gesture recognition,
  tempo detection)

Do not create a custom interaction when:

- A built-in interaction already handles your use case
- The logic is simple enough to handle inline in an event handler
- The pattern is only used in one place

## Defining an interaction

Use `defineInteraction` to create a reusable interaction:

```ts
import { defineInteraction, type Interaction } from '@remix-run/interaction'

// 1. Define the interaction with a unique namespaced type
export let dragRelease = defineInteraction('myapp:drag-release', DragRelease)

// 2. Declare the event type for TypeScript
declare global {
	interface HTMLElementEventMap {
		[dragRelease]: DragReleaseEvent
	}
}

// 3. Create a custom event class with relevant data
export class DragReleaseEvent extends Event {
	velocityX: number
	velocityY: number

	constructor(
		type: typeof dragRelease,
		init: { velocityX: number; velocityY: number },
	) {
		super(type, { bubbles: true, cancelable: true })
		this.velocityX = init.velocityX
		this.velocityY = init.velocityY
	}
}

// 4. Implement the interaction setup function
function DragRelease(handle: Interaction) {
	if (!(handle.target instanceof HTMLElement)) return

	let target = handle.target
	let isTracking = false
	let velocityX = 0
	let velocityY = 0

	handle.on(target, {
		pointerdown(event) {
			if (!event.isPrimary) return
			isTracking = true
			target.setPointerCapture(event.pointerId)
		},

		pointermove(event) {
			if (!isTracking) return
			// Track velocity...
		},

		pointerup(event) {
			if (!isTracking) return
			isTracking = false

			// Dispatch the custom event
			target.dispatchEvent(
				new DragReleaseEvent(dragRelease, { velocityX, velocityY }),
			)
		},
	})
}
```

## The interaction handle

The setup function receives an `Interaction` handle with:

- **`handle.target`** - The element the interaction is attached to
- **`handle.signal`** - AbortSignal for cleanup when the interaction is disposed
- **`handle.on(target, listeners)`** - Add event listeners with automatic
  cleanup
- **`handle.raise(error)`** - Report errors to the parent error handler

```ts
function MyInteraction(handle: Interaction) {
	// Guard for specific element types if needed
	if (!(handle.target instanceof HTMLElement)) return

	let target = handle.target

	// Set up listeners - automatically cleaned up when signal aborts
	handle.on(target, {
		pointerdown(event) {
			// Handle event...
		},
	})

	// Listen to other targets (e.g., document for global events)
	handle.on(target.ownerDocument, {
		pointerup() {
			// Handle pointer released outside target...
		},
	})
}
```

## Navigation

- [Interaction examples](./interactions-examples.md)
- [Component index](./index.md)
