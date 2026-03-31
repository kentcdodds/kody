# Animate tips

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/animate.md

## Tips

- **Keep durations short**: 100-300ms feels snappy. Longer durations can feel
  sluggish.
- **Use `ease-out` for enter**: Elements should decelerate as they arrive at
  their final position.
- **Use `ease-in` for exit**: Elements should accelerate as they leave.
- **Use springs for layout**: Physics-based easing feels natural for
  position/size changes.
- **Always use `key` for animated elements**: Keys are required for reclamation
  (interrupting exit to re-enter) and for layout animations to track element
  identity. Even conditionally rendered elements need keys:
  `{show && <Element key="..." />}`
- **Skip animation on first render**: For elements like labels that shouldn't
  animate on initial mount, use a falsy value for `enter`:

```tsx
function Label(handle: Handle) {
	let isFirstRender = true
	handle.queueTask(() => {
		isFirstRender = false
	})

	return (props: { text: string }) => (
		<span animate={{ enter: isFirstRender ? false : { opacity: 0 } }}>
			{props.text}
		</span>
	)
}
```

## Navigation

- [Animate layout](./animate-layout.md)
- [Component index](./index.md)
