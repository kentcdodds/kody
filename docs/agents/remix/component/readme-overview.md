# Component README: overview

Source: https://github.com/remix-run/remix/tree/main/packages/component

## Overview

A minimal component system that leans on JavaScript and DOM primitives.

## Features

- **JSX Runtime** - Convenient JSX syntax
- **Component State** - State managed with plain JavaScript variables
- **Manual Updates** - Explicit control over when components update via
  `handle.update()`
- **Real DOM Events** - Events are real DOM events using
  [`@remix-run/interaction`](../interaction/index.md)
- **Inline CSS** - CSS prop with pseudo-selectors and nested rules

## Installation

```sh
bun add @remix-run/component
```

## Getting started

Create a root and render a component:

```tsx
import { createRoot } from '@remix-run/component'

function App(handle: Handle) {
	let count = 0
	return () => (
		<button
			on={{
				click: () => {
					count++
					handle.update()
				},
			}}
		>
			Count: {count}
		</button>
	)
}

createRoot(document.body).render(<App />)
```

Components are functions that receive a `Handle` as their first argument. They
must return a render function that receives props.

## Navigation

- [Component state and setup props](./readme-components.md)
- [Events](./readme-events.md)
- [Component index](./index.md)
