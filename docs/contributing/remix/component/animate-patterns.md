# Animate patterns

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/animate.md

## Common patterns

### Slide down from top

```tsx
<div
	animate={{
		enter: { opacity: 0, transform: 'translateY(-10px)' },
		exit: { opacity: 0, transform: 'translateY(-10px)' },
	}}
>
	Dropdown menu
</div>
```

### Slide with blur (icon swap)

```tsx
let iconAnimation = {
	enter: {
		transform: 'translateY(-40px) scale(0.5)',
		filter: 'blur(6px)',
		duration: 100,
		easing: 'ease-out',
	},
	exit: {
		transform: 'translateY(40px) scale(0.5)',
		filter: 'blur(6px)',
		duration: 100,
		easing: 'ease-in',
	},
}

// Use for swapping icons or labels - keys enable smooth cross-fade
{
	state === 'loading' ? (
		<div key="loading" animate={iconAnimation}>
			Loading
		</div>
	) : (
		<div key="success" animate={iconAnimation}>
			Done
		</div>
	)
}
```

### Enter only (no exit animation)

Element animates in but disappears instantly when removed:

```tsx
<div animate={{ enter: { opacity: 0 }, exit: false }}>One-way animation</div>
```

### Exit only (no enter animation)

Element appears instantly but animates out:

```tsx
<div animate={{ enter: false, exit: { opacity: 0 } }}>Fade out only</div>
```

### With delay

Stagger animations or wait before starting:

```tsx
<div animate={{ enter: { opacity: 0, delay: 100 } }}>Delayed entrance</div>
```

## Interruption handling

If a user toggles an element before its animation finishes, the current
animation reverses from its current position rather than jumping to the other
animation. This creates smooth, interruptible transitions.

```tsx
// User clicks "Toggle" to show element
// Enter animation starts: opacity 0 -> 1
// User clicks "Toggle" again at opacity 0.4
// Animation reverses: opacity 0.4 -> 0 (doesn't jump to exit animation)
```

If an exit animation is interrupted, it reverses and the node is reclaimed back
into the virtual DOM.

**Important**: For reclamation to work, the element must have a `key` prop:

```tsx
// Reclamation works - element can be interrupted and reused
{
	show && (
		<div key="panel" animate={{ exit: { opacity: 0 } }}>
			...
		</div>
	)
}

// No reclamation - element is recreated each time
{
	show && <div animate={{ exit: { opacity: 0 } }} />
}
```

Without a key, the reconciler can't determine if a new element should reclaim an
exiting one, so interrupting an exit animation will still remove the old element
and create a new one.

## With spring easing

Spread a spring value to get physics-based `duration` and `easing`:

```tsx
import { spring } from '@remix-run/component'

let el = (
	<div animate={{ enter: { opacity: 0, ...spring('bouncy') } }}>
		Bouncy modal
	</div>
)
```

See [Spring basics](./spring-basics.md) for available presets and custom spring
options.

## Complete example

A toggle component with animate:

```tsx
import { createRoot, type Handle } from '@remix-run/component'

function ToggleContent(handle: Handle) {
	let show = false

	return () => (
		<>
			<button
				on={{
					click() {
						show = !show
						handle.update()
					},
				}}
			>
				Toggle
			</button>

			{show && (
				<div
					key="content"
					animate={{ enter: { opacity: 0 }, exit: { opacity: 0 } }}
				>
					Content that animates in and out
				</div>
			)}
		</>
	)
}
```

## Navigation

- [Animate basics](./animate-basics.md)
- [Animate layout](./animate-layout.md)
- [Component index](./index.md)
