# Tween advanced usage

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/tween.md

## Custom curves

Define a custom cubic-bezier curve:

```tsx
import { tween } from '@remix-run/component'

let custom = tween({
	duration: 400,
	easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
})
```

## When to use tween vs spring

Use `tween` when:

- You want precise duration control
- You want standard easing curves
- You want predictable timing (no overshoot)

Use `spring` when:

- You want natural physics-based motion
- You want smooth interruption handling
- You want dynamic response based on motion values

## See also

- [Spring basics](./spring-basics.md)
- [Animate basics](./animate-basics.md)

## Navigation

- [Tween basics](./tween-basics.md)
- [Component index](./index.md)
