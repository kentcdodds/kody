# compression-middleware

Source:
https://github.com/remix-run/remix/tree/main/packages/compression-middleware

## Overview

Middleware for compressing HTTP responses for use with
[`@remix-run/fetch-router`](https://github.com/remix-run/remix/tree/main/packages/fetch-router).

Automatically compresses responses using `gzip`, `brotli`, or `deflate` based on
the client's `Accept-Encoding` header, with intelligent defaults for media type
filtering and threshold-based compression.

## Installation

```sh
bun add @remix-run/compression-middleware
```

## Usage

```ts
import { createRouter } from '@remix-run/fetch-router'
import { compression } from '@remix-run/compression-middleware'

let router = createRouter({
	middleware: [compression()],
})
```

The middleware will automatically compress responses for compressible MIME types
when:

- The client supports compression (`Accept-Encoding` header with a supported
  encoding)
- The response is large enough to benefit from compression (>=1024 bytes if
  `Content-Length` is present, by default)
- The response hasn't already been compressed
- The response doesn't advertise range support (`Accept-Ranges: bytes`)

## Navigation

- [Options and configuration](./options.md)
- [Remix package index](../index.md)
