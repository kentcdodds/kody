# fetch-router

Source: https://github.com/remix-run/remix/tree/main/packages/fetch-router

## Overview

A minimal, composable router built on the
[web Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API) and
[`route-pattern`](../route-pattern). Ideal for building APIs, web services, and
server-rendered applications across any JavaScript runtime.

## Features

- **Fetch API**: Built on standard web APIs that work everywhere - Node.js, Bun,
  Deno, Cloudflare Workers, and browsers
- **Type-Safe Routing**: Leverage TypeScript for compile-time route validation
  and parameter inference
- **Composable Architecture**: Nest routers, combine middleware, and organize
  routes hierarchically
- **Declarative Route Maps**: Define your entire route structure upfront with
  type-safe route names and request methods
- **Flexible Middleware**: Apply middleware globally, per-route, or to entire
  route hierarchies
- **Easy Testing**: Use standard `fetch()` to test your routes - no special test
  harness required

## Goals

- **Simplicity**: A router should be simple to understand and use. The entire
  API surface fits in your head.
- **Composability**: Small routers combine to build large applications.
  Middleware and nested routers make organization natural.
- **Standards-Based**: Built on web standards that work across runtimes. No
  proprietary APIs or Node.js-specific code.

## Installation

```sh
npm i remix
```

Import route definition helpers from `remix/fetch-router/routes`, and runtime
APIs from `remix/fetch-router`.

## Navigation

- [Basic usage and route maps](./usage.md)
- [Routing based on request method](./routing-methods.md)
- [Resource-based routes](./routing-resources.md)
- [Middleware and request context](./middleware.md)
- [Additional topics and HTML helpers](./advanced-topics.md)
- [Testing and related work](./testing-and-related.md)
- [Remix package index](../index.md)
