# Pattern: data loading

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/patterns.md

## Using event handler signals

Event handlers receive an `AbortSignal` that's aborted when the handler is
re-entered:

```tsx
function SearchInput(handle: Handle) {
	let results: string[] = []
	let loading = false

	return () => (
		<div>
			<input
				on={{
					async input(event, signal) {
						let query = event.currentTarget.value
						loading = true
						handle.update()

						let response = await fetch(`/search?q=${query}`, { signal })
						let data = await response.json()
						if (signal.aborted) return

						results = data.results
						loading = false
						handle.update()
					},
				}}
			/>
			{loading && <div>Loading...</div>}
			{!loading && results.length > 0 && (
				<ul>
					{results.map((result, i) => (
						<li key={i}>{result}</li>
					))}
				</ul>
			)}
		</div>
	)
}
```

## Using queueTask for reactive loading

Use `handle.queueTask()` in the render function for reactive data loading that
responds to prop changes:

```tsx
function DataLoader(handle: Handle) {
	let data: any = null
	let loading = false
	let error: Error | null = null

	return (props: { url: string }) => {
		// Queue data loading task that responds to prop changes
		handle.queueTask(async (signal) => {
			loading = true
			error = null
			handle.update()

			let response = await fetch(props.url, { signal })
			let json = await response.json()
			if (signal.aborted) return
			data = json
			loading = false
			handle.update()
		})

		if (loading) return <div>Loading...</div>
		if (error) return <div>Error: {error.message}</div>
		if (!data) return <div>No data</div>

		return <div>{JSON.stringify(data)}</div>
	}
}
```

## Using setup scope for initial data

Load initial data in the setup scope:

```tsx
function UserProfile(handle: Handle, setup: { userId: string }) {
	let user: User | null = null
	let loading = true

	// Load initial data in setup scope using queueTask
	handle.queueTask(async (signal) => {
		let response = await fetch(`/api/users/${setup.userId}`, { signal })
		let data = await response.json()
		if (signal.aborted) return
		user = data
		loading = false
		handle.update()
	})

	return (props: { showEmail?: boolean }) => {
		if (loading) return <div>Loading user...</div>

		return (
			<div>
				<div>{user.name}</div>
				{props.showEmail && <div>{user.email}</div>}
			</div>
		)
	}
}
```

Note that by fetching this data in the setup scope any parent updates that
change `setup.userId` will have no effect.

## See also

- [Handle updates and tasks](./handle-updates.md)
- [Event handling basics](./events-basics.md)
- [Components](./components.md)

## Navigation

- [Pattern: inputs](./patterns-inputs.md)
- [Component index](./index.md)
