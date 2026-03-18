# Animate layout

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/animate.md

The `layout` property enables automatic FLIP (First, Last, Invert, Play)
animations when an element's position or size changes due to layout shifts.
Instead of the element jumping to its new position, it smoothly animates there.

## Basic usage

Enable layout animations with `layout: true`:

```tsx
<div animate={{ layout: true }}>Animates position/size changes</div>
```

Or customize duration and easing, including springs:

```tsx
import { spring } from '@remix-run/component'

let custom = (
	<div animate={{ layout: { duration: 300, easing: 'ease-in-out' } }}>Ease</div>
)

let springEasing = (
	<div animate={{ layout: { ...spring('bouncy') } }}>Bouncy</div>
)
```

## How it works

Layout animations use the FLIP technique:

1. **First**: Before any DOM changes, the element's current position is captured
2. **Last**: After DOM changes, the new position is measured
3. **Invert**: A CSS transform is applied to make the element appear at its old
   position
4. **Play**: The transform animates to identity, moving the element to its new
   position

This approach is performant because it only animates `transform` (and optionally
`scale`), which are GPU-accelerated and don't trigger layout recalculations.

## What gets animated

Layout animations handle:

- **Position changes**: Moving left/right/up/down via `translate3d()`
- **Size changes**: Width/height changes via `scale()`

## Example: toggle switch

A classic use case is animating a toggle knob when its `justify-content`
changes:

```tsx
function FlipToggle(handle: Handle) {
	let isOn = false

	return () => (
		<button
			on={{
				click() {
					isOn = !isOn
					handle.update()
				},
			}}
		>
			<div
				animate={{ layout: true }}
				css={{
					display: 'flex',
					justifyContent: isOn ? 'flex-end' : 'flex-start',
				}}
			>
				<div css={{ width: 24, height: 24 }} />
			</div>
		</button>
	)
}
```

When clicked, the knob smoothly slides from one side to the other instead of
jumping.

## Example: list reordering

Layout animations shine when reordering list items:

```tsx
function ReorderableList(handle: Handle) {
	let items = [
		{ id: 'a', name: 'Apple' },
		{ id: 'b', name: 'Banana' },
		{ id: 'c', name: 'Cherry' },
	]

	function shuffle() {
		items = [...items].sort(() => Math.random() - 0.5)
		handle.update()
	}

	return () => (
		<>
			<button on={{ click: shuffle }}>Shuffle</button>
			<ul>
				{items.map((item) => (
					<li key={item.id} animate={{ layout: true }}>
						{item.name}
					</li>
				))}
			</ul>
		</>
	)
}
```

Each item animates to its new position when the list order changes.

## Combining with enter/exit

Layout animations work alongside enter/exit animations:

```tsx
<div animate={{ layout: true, enter: { opacity: 0 }, exit: { opacity: 0 } }}>
	Fades in/out and animates position changes
</div>
```

## Interruption

Layout animations are interruptible. If the layout changes again while an
animation is in progress:

1. The current animation is cancelled
2. The element's current visual position is captured
3. A new animation starts from that position to the new target

This ensures smooth transitions even during rapid layout changes.

## Configuration options

```tsx
interface LayoutAnimationConfig {
	duration?: number // Animation duration in ms (default: 200)
	easing?: string // CSS easing function (default: 'ease-out')
}
```

All options are optional - use `layout: true` for defaults, or customize:

```tsx
// Just layout with defaults
animate={{ layout: true }}

// Custom duration only
animate={{ layout: { duration: 300 } }}

// Custom easing only
animate={{ layout: { easing: 'ease-in-out' } }}

// Spring physics
animate={{ layout: { ...spring('bouncy') } }}
```

## Navigation

- [Animate basics](./animate-basics.md)
- [Animate tips](./animate-tips.md)
- [Component index](./index.md)
