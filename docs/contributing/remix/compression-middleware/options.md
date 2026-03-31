# Compression options

Source:
https://github.com/remix-run/remix/tree/main/packages/compression-middleware

## Threshold

**Default:** `1024` (only enforced if `Content-Length` is present)

Set the minimum response size in bytes to compress:

```ts
import { createRouter } from '@remix-run/fetch-router'
import { compression } from '@remix-run/compression-middleware'

let router = createRouter({
	middleware: [
		compression({
			threshold: 2048, // Only compress responses >=2KB
		}),
	],
})
```

## Encodings

**Default:** `['br', 'gzip', 'deflate']`

Customize which compression algorithms to support:

```ts
import { createRouter } from '@remix-run/fetch-router'
import { compression } from '@remix-run/compression-middleware'

let router = createRouter({
	middleware: [
		compression({
			encodings: ['br', 'gzip'], // Only use Brotli and Gzip
		}),
	],
})
```

The `encodings` option can also be a function that receives the response:

```ts
import { createRouter } from '@remix-run/fetch-router'
import { compression } from '@remix-run/compression-middleware'

let router = createRouter({
	middleware: [
		compression({
			encodings: (response) => {
				// Use different encodings for server-sent events
				let contentType = response.headers.get('Content-Type')
				return contentType?.startsWith('text/event-stream;')
					? ['gzip', 'deflate']
					: ['br', 'gzip', 'deflate']
			},
		}),
	],
})
```

## Filter media type

**Default:** Uses `isCompressibleMimeType()` from
[`@remix-run/mime`](https://github.com/remix-run/remix/tree/main/packages/mime)

You can customize this behavior with the `filterMediaType` option:

```ts
import { createRouter } from '@remix-run/fetch-router'
import { compression } from '@remix-run/compression-middleware'
import { isCompressibleMimeType } from '@remix-run/mime'

let router = createRouter({
	middleware: [
		compression({
			filterMediaType(mediaType) {
				// Add a custom media type to the default compressible list
				return (
					isCompressibleMimeType(mediaType) ||
					mediaType === 'application/vnd.example+data'
				)
			},
		}),
	],
})
```

## Compression options

**Default:** Uses Node.js defaults for
[zlib](https://nodejs.org/api/zlib.html#class-options) and
[Brotli](https://nodejs.org/api/zlib.html#class-brotlioptions), with automatic
flush handling for server-sent events.

You can pass options options to the underlying Node.js `zlib` and `brotli`
compressors for fine-grained control:

```ts
import { createRouter } from '@remix-run/fetch-router'
import { compression } from '@remix-run/compression-middleware'
import { zlib } from 'node:zlib'

let router = createRouter({
	middleware: [
		compression({
			zlib: {
				level: 6,
			},
			brotli: {
				params: {
					[zlib.constants.BROTLI_PARAM_QUALITY]: 4,
				},
			},
		}),
	],
})
```

Like `encodings`, both `zlib` and `brotli` options can also be functions that
receive the response:

```ts
import zlib from 'node:zlib'
import { createRouter } from '@remix-run/fetch-router'
import { compression } from '@remix-run/compression-middleware'

let router = createRouter({
	middleware: [
		compression({
			brotli: (response) => {
				let contentType = response.headers.get('Content-Type')
				return {
					params: {
						[zlib.constants.BROTLI_PARAM_QUALITY]: contentType?.startsWith(
							'text/html;',
						)
							? 4
							: 11,
					},
				}
			},
		}),
	],
})
```

## Related packages

- [`@remix-run/fetch-router`](https://github.com/remix-run/remix/tree/main/packages/fetch-router) -
  Router for the web Fetch API
- [`@remix-run/mime`](https://github.com/remix-run/remix/tree/main/packages/mime) -
  MIME type utilities
- [`@remix-run/response`](https://github.com/remix-run/remix/tree/main/packages/response) -
  Response helpers

## License

MIT

## Navigation

- [Compression middleware overview](./index.md)
- [Remix package index](../index.md)
