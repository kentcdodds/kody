# Spring basics

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/spring.md

The `spring` utility computes duration and easing values for natural
spring-based motion.

## Basic usage

```tsx
import { spring } from '@remix-run/component'

let { duration, easing } = spring()
```

Use the returned values with the `animate` prop:

```tsx
<div
	animate={{
		enter: {
			opacity: 0,
			transform: 'scale(0.9)',
			...spring(),
		},
	}}
/>
```

## Presets

Available presets:

- `default`
- `fast`
- `slow`
- `gentle`
- `bouncy`

```tsx
<div animate={{ enter: { opacity: 0, ...spring('bouncy') } }} />
```

## Using with CSS transitions

You can also use the values with CSS transitions:

```tsx
let { duration, easing } = spring()

<div
	style={{
		transition: `transform ${duration}ms ${easing}`,
	}}
/>
```

## Navigation

- [Spring advanced usage](./spring-advanced.md)
- [Component index](./index.md)
