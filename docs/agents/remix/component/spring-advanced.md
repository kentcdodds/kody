# Spring advanced usage

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/spring.md

## Custom springs

Customize spring parameters for finer control:

```tsx
import { spring } from '@remix-run/component'

let custom = spring({
	mass: 1,
	stiffness: 170,
	damping: 26,
	velocity: 0,
})
```

Available parameters:

- `mass` - Higher values move slower
- `stiffness` - Higher values move faster
- `damping` - Higher values reduce oscillation
- `velocity` - Initial velocity

## Using for JS animations

You can use the spring to compute keyframes over time for JavaScript-driven
animations:

```tsx
import { spring } from '@remix-run/component'

let { duration, easing } = spring('bouncy')

let keyframes = [{ transform: 'scale(0.9)' }, { transform: 'scale(1)' }]

element.animate(keyframes, {
	duration,
	easing,
})
```

## Reading raw values

Use `spring()` to compute raw animation values in a render loop:

```ts
import { spring } from '@remix-run/component'

let springValue = spring({ mass: 1, stiffness: 170, damping: 26 })
// springValue.duration, springValue.easing
```

## Navigation

- [Spring basics](./spring-basics.md)
- [Component index](./index.md)
