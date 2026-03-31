# Pattern: inputs

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/patterns.md

Only control an input's value when something besides the user's interaction with
that input can also control its state.

## Uncontrolled input

Use when only the user controls the value:

```tsx
function SearchInput(handle: Handle) {
	let results: string[] = []

	return () => (
		<div>
			<input />
			<button>Search</button>
		</div>
	)
}
```

## Controlled input

Use when programmatic control is needed:

```tsx
function SlugForm(handle: Handle) {
	let slug = ''
	let generatedSlug = ''

	return () => (
		<div>
			<button
				on={{
					click() {
						generatedSlug = 'new-slug'
						slug = generatedSlug
						handle.update()
					},
				}}
			>
				Auto-generate slug
			</button>
			<label>
				Slug
				<input
					value={slug}
					on={{
						input(event) {
							slug = event.currentTarget.value
							handle.update()
						},
					}}
				/>
			</label>
		</div>
	)
}
```

Use controlled inputs when:

- The value can be set programmatically (auto-generated fields, reset buttons,
  external state)
- The input can be disabled and its value changed by other interactions
- You need to validate or transform input before it appears
- You need to prevent certain values from being entered

Use uncontrolled inputs when:

- Only the user can change the value through direct interaction with that input
- You just need to read the value on events (submit, blur, etc.)

## Navigation

- [Pattern: data loading](./patterns-data-loading.md)
- [Component index](./index.md)
