# Animate basics

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/animate.md

Declarative animations for element lifecycle and layout changes. The `animate`
prop handles three types of animations:

- **Enter**: Animation played when an element mounts
- **Exit**: Animation played when an element is removed (element persists until
  animation completes)
- **Layout**: FLIP animation when an element's position or size changes

## How it works

The `animate` prop is an intrinsic property that wraps the Web Animations API
(`element.animate()`). The reconciler handles the complexity:

- **Enter**: Element animates from the specified keyframe(s) to its natural
  styles
- **Exit**: Element animates from its current styles to the specified
  keyframe(s)
- **Layout**: Element smoothly animates from old position/size to new using FLIP
  technique
- **DOM persistence**: When a vnode is removed, the element stays in the DOM
  until the exit animation finishes
- **Interruption**: If an animation is interrupted mid-flight, it reverses from
  its current position rather than jumping to the other animation

## Basic usage

### Default animations

Use `true` to enable default animations for each type:

```tsx
<div animate>Hello</div>
```

This enables:

- **Enter**: Fade in (150ms, ease-out)
- **Exit**: Fade out (150ms, ease-in)
- **Layout**: FLIP position/size animation (200ms, ease-out)

Mix and match as needed:

```tsx
<div animate={{ enter: true, exit: true }} />
<div animate={{ layout: true }} />
<div animate={{ exit: true }} />
```

### Single keyframe (shorthand)

The `enter` keyframe defines the starting state - the element animates from
these values to its natural styles. The `exit` keyframe defines the ending state

- the element animates from its current styles to these values:

```tsx
<div
	animate={{
		enter: { opacity: 0, transform: 'scale(0.9)' },
		exit: { opacity: 0, transform: 'scale(0.9)' },
	}}
>
	Modal content
</div>
```

### Multi-step animations

For complex sequences, provide an array of keyframes:

```tsx
<div
	animate={{
		enter: [
			{ opacity: 0, transform: 'translateY(10px)' },
			{ opacity: 1, transform: 'translateY(0)' },
		],
	}}
>
	Toast notification
</div>
```

### Conditional animations

Use falsy values to disable animations conditionally. This is useful for
skipping the enter animation on initial render:

```tsx
<div
	animate={{
		enter: isFirstRender ? false : { opacity: 0 },
		exit: { opacity: 0 },
	}}
>
	Content
</div>
```

When `enter` is falsy (`false`, `null`, `undefined`), the element appears
instantly with no animation. The exit animation still plays when the element is
removed.

## Navigation

- [Animate patterns](./animate-patterns.md)
- [Animate layout](./animate-layout.md)
- [Component index](./index.md)
