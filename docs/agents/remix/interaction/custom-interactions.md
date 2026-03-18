# Custom interactions and typed targets

Source: https://github.com/remix-run/remix/tree/main/packages/interaction

## Custom interactions

Define semantic interactions that can dispatch custom events and be reused
declaratively.

```ts
import { defineInteraction, on, type Interaction } from '@remix-run/interaction'

// Provide type safety for consumers
declare global {
	interface HTMLElementEventMap {
		[keydownEnter]: KeyboardEvent
	}
}

function KeydownEnter(handle: Interaction) {
	if (!(handle.target instanceof HTMLElement)) return

	handle.on(handle.target, {
		keydown(event) {
			if (event.key === 'Enter') {
				handle.target.dispatchEvent(
					new KeyboardEvent(keydownEnter, { key: 'Enter' }),
				)
			}
		},
	})
}

// define the interaction type and setup function
const keydownEnter = defineInteraction('keydown:enter', KeydownEnter)

// usage
let button = document.createElement('button')
on(button, {
	[keydownEnter](event) {
		console.log('Enter key pressed')
	},
})
```

Notes:

- An interaction is initialized at most once per target, even if multiple
  listeners bind the same interaction type.

## Typed event targets

Use `TypedEventTarget<eventMap>` to get type-safe `addEventListener` and
integrate with this library's `on` helpers.

```ts
import { TypedEventTarget, on } from '@remix-run/interaction'

interface DrummerEventMap {
	kick: DrummerEvent
	snare: DrummerEvent
	hat: DrummerEvent
}

class DrummerEvent extends Event {
	constructor(type: keyof DrummerEventMap) {
		super(type)
	}
}

class Drummer extends TypedEventTarget<DrummerEventMap> {
	kick() {
		// ...
		this.dispatchEvent(new DrummerEvent('kick'))
	}
}

let drummer = new Drummer()

// native API is NOT typed
drummer.addEventListener('kick', (event) => {
	// event is DrummerEvent
})

// type safe with on()
on(drummer, {
	kick: (event) => {
		// event is Dispatched<DrummerEvent, Drummer>
	},
})
```

## Demos

The
[`demos` directory](https://github.com/remix-run/remix/tree/main/packages/interaction/demos)
contains working demos:

- [`demos/async`](https://github.com/remix-run/remix/tree/main/packages/interaction/demos/async) -
  Async listeners with abort signal
- [`demos/basic`](https://github.com/remix-run/remix/tree/main/packages/interaction/demos/basic) -
  Basic event handling
- [`demos/form`](https://github.com/remix-run/remix/tree/main/packages/interaction/demos/form) -
  Form event handling
- [`demos/keys`](https://github.com/remix-run/remix/tree/main/packages/interaction/demos/keys) -
  Keyboard interactions
- [`demos/popover`](https://github.com/remix-run/remix/tree/main/packages/interaction/demos/popover) -
  Popover interactions
- [`demos/press`](https://github.com/remix-run/remix/tree/main/packages/interaction/demos/press) -
  Press and long press interactions

## License

See [LICENSE](https://github.com/remix-run/remix/blob/main/LICENSE)

## Navigation

- [interaction overview](./index.md)
- [Event listeners and interactions](./listeners.md)
- [Remix package index](../index.md)
