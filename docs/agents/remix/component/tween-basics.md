# Tween basics

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/tween.md

The `tween` utility generates duration and easing for time-based animations.

## Basic usage

```tsx
import { tween } from '@remix-run/component'

let { duration, easing } = tween()
```

Use with `animate`:

```tsx
<div
	animate={{
		enter: {
			opacity: 0,
			...tween(),
		},
	}}
/>
```

## Presets

```tsx
<div animate={{ enter: { opacity: 0, ...tween('ease-in-out') } }} />
```

## Navigation

- [Tween advanced usage](./tween-advanced.md)
- [Component index](./index.md)
