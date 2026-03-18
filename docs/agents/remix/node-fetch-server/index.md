# node-fetch-server

Source: https://github.com/remix-run/remix/tree/main/packages/node-fetch-server

## Overview

Build portable Node.js servers using web-standard Fetch API primitives.

`node-fetch-server` brings the simplicity and familiarity of the
[Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API) to
Node.js server development. Instead of dealing with Node's traditional
`req`/`res` objects, you work with web-standard
[`Request`](https://developer.mozilla.org/en-US/docs/Web/API/Request) and
[`Response`](https://developer.mozilla.org/en-US/docs/Web/API/Response)
objects - the same APIs you already use in the browser and modern JavaScript
runtimes.

## Features

- **Web Standards** - Standard `Request` and `Response` APIs
- **Drop-in Integration** - Works with `node:http` and `node:https`
- **Streaming Support** - Response support with `ReadableStream`
- **Custom Hostname** - Configuration for deployment flexibility
- **Client Info** - Access to client connection info (IP address, port)
- **TypeScript** - Full TypeScript support with type definitions

## Installation

```sh
bun add @remix-run/node-fetch-server
```

## Navigation

- [Quick start examples](./quick-start.md)
- [Advanced usage](./advanced-usage.md)
- [Migration from Express](./migration.md)
- [Demos and benchmark](./demos-and-benchmark.md)
- [Remix package index](../index.md)
