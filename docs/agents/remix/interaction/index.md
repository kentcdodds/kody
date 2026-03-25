# interaction

Source: https://github.com/remix-run/remix/tree/main/packages/interaction

## Overview

Enhanced events and custom interactions for any
[EventTarget](https://developer.mozilla.org/en-US/docs/Web/API/EventTarget).

## Features

- **Declarative Bindings** - Event bindings with plain objects
- **Semantic Interactions** - Reusable "interactions" like `longPress` and
  `arrowDown`
- **Async Support** - Listeners with reentry protection via
  [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)
- **Type Safety** - Type-safe listeners and custom `EventTarget` subclasses with
  `TypedEventTarget`

## Installation

```sh
npm install @remix-run/interaction
```

## Quick start

```ts
import { on } from '@remix-run/interaction'

let inputElement = document.createElement('input')

on(inputElement, {
	input: (event, signal) => {
		console.log('current value', event.currentTarget.value)
	},
})
```

## Navigation

- [Event listeners and interactions](./listeners.md)
- [Containers and disposal](./containers-and-disposal.md)
- [Custom interactions and typed targets](./custom-interactions.md)
- [Remix package index](../index.md)
