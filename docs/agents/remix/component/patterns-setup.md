# Pattern: setup scope

Source:
https://github.com/remix-run/remix/tree/main/packages/component/docs/patterns.md

The setup scope is perfect for one-time initialization.

## Initializing instances

```tsx
function CacheExample(handle: Handle, setup: { cacheSize: number }) {
	// Initialize cache once
	let cache = new Map()
	let maxSize = setup.cacheSize

	return (props: { key: string; value: any }) => {
		// Use cache in render
		if (cache.has(props.key)) {
			return <div>Cached: {cache.get(props.key)}</div>
		}
		cache.set(props.key, props.value)
		if (cache.size > maxSize) {
			let firstKey = cache.keys().next().value
			cache.delete(firstKey)
		}
		return <div>New: {props.value}</div>
	}
}
```

## Third-party SDKs

```tsx
function Analytics(handle: Handle, setup: { apiKey: string }) {
	// Initialize SDK once
	let analytics = new AnalyticsSDK(setup.apiKey)

	// Cleanup on disconnect
	handle.signal.addEventListener('abort', () => {
		analytics.disconnect()
	})

	return (props: { event: string; data?: any }) => {
		// SDK is ready to use
		return <div>Tracking: {props.event}</div>
	}
}
```

## Event emitters

```tsx
import { TypedEventTarget } from '@remix-run/interaction'

class DataEvent extends Event {
	constructor(public value: string) {
		super('data')
	}
}

class DataEmitter extends TypedEventTarget<{ data: DataEvent }> {
	emitData(value: string) {
		this.dispatchEvent(new DataEvent(value))
	}
}

function EventListener(handle: Handle, setup: DataEmitter) {
	// Set up listeners once with automatic cleanup
	handle.on(setup, {
		data(event) {
			// Handle data
			handle.update()
		},
	})

	return () => <div>Listening for events...</div>
}
```

## Window and document events

```tsx
function WindowResizeTracker(handle: Handle) {
	let width = window.innerWidth
	let height = window.innerHeight

	// Set up global listeners once
	handle.on(window, {
		resize() {
			width = window.innerWidth
			height = window.innerHeight
			handle.update()
		},
	})

	return () => (
		<div>
			Window size: {width} x {height}
		</div>
	)
}
```

## Initializing state from props

```tsx
function Timer(handle: Handle, setup: { initialSeconds: number }) {
	// Initialize from setup prop
	let seconds = setup.initialSeconds
	let interval: number | null = null

	function start() {
		if (interval) return
		interval = setInterval(() => {
			seconds--
			if (seconds <= 0) {
				stop()
			}
			handle.update()
		}, 1000)
	}

	function stop() {
		if (interval) {
			clearInterval(interval)
			interval = null
		}
	}

	// Cleanup on disconnect
	handle.signal.addEventListener('abort', stop)

	return (props: { paused?: boolean }) => {
		if (!props.paused && !interval) {
			start()
		} else if (props.paused && interval) {
			stop()
		}

		return <div>Time remaining: {seconds}s</div>
	}
}
```

## Navigation

- [Pattern: focus and scroll](./patterns-focus-and-scroll.md)
- [Component index](./index.md)
