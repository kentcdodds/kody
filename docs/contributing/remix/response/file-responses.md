# File responses

Source: https://github.com/remix-run/remix/tree/main/packages/response

The `createFileResponse` helper creates a response for serving files with full
HTTP semantics. It works with both native `File` objects and `LazyFile` from
`@remix-run/lazy-file`.

```ts
import { createFileResponse } from '@remix-run/response/file'
import { openLazyFile } from '@remix-run/fs'

let lazyFile = openLazyFile('./public/image.jpg')
let response = await createFileResponse(lazyFile, request, {
	cacheControl: 'public, max-age=3600',
})
```

## Features

- **Content-Type** and **Content-Length** headers
- **ETag** generation (weak or strong)
- **Last-Modified** headers
- **Cache-Control** headers
- **Conditional requests** (`If-None-Match`, `If-Modified-Since`, `If-Match`,
  `If-Unmodified-Since`)
- **Range requests** for partial content (`206 Partial Content`)
- **HEAD** request support

## Options

```ts
await createFileResponse(file, request, {
	// Cache-Control header value.
	// Defaults to `undefined` (no Cache-Control header).
	cacheControl: 'public, max-age=3600',

	// ETag generation strategy:
	// - 'weak': Generates weak ETags based on file size and mtime (default)
	// - 'strong': Generates strong ETags by hashing file content
	// - false: Disables ETag generation
	etag: 'weak',

	// Hash algorithm for strong ETags (Web Crypto API algorithm names).
	// Only used when etag: 'strong'.
	// Defaults to 'SHA-256'.
	digest: 'SHA-256',

	// Whether to generate Last-Modified headers.
	// Defaults to `true`.
	lastModified: true,

	// Whether to support HTTP Range requests for partial content.
	// Defaults to `true`.
	acceptRanges: true,
})
```

## Strong ETags and content hashing

For assets that require strong validation (e.g., to support
[`If-Match`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-Match)
preconditions or
[`If-Range`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-Range)
with
[`Range` requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Range)),
configure strong ETag generation:

```ts
return createFileResponse(file, request, {
	etag: 'strong',
})
```

By default, strong ETags are generated using the Web Crypto API with the
`'SHA-256'` algorithm. You can customize this:

```ts
return createFileResponse(file, request, {
	etag: 'strong',
	// Specify a different hash algorithm
	digest: 'SHA-512',
})
```

For large files or custom hashing requirements, provide a custom digest
function:

```ts
await createFileResponse(file, request, {
	etag: 'strong',
	async digest(file) {
		// Custom streaming hash for large files
		let { createHash } = await import('node:crypto')
		let hash = createHash('sha256')
		for await (let chunk of file.stream()) {
			hash.update(chunk)
		}
		return hash.digest('hex')
	},
})
```

## Navigation

- [Response overview](./index.md)
- [HTML responses](./html-responses.md)
- [Remix package index](../index.md)
