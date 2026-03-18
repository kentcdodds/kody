# Compressed responses

Source: https://github.com/remix-run/remix/tree/main/packages/response

The `compressResponse` helper compresses a `Response` based on the client's
`Accept-Encoding` header:

```ts
import { compressResponse } from '@remix-run/response/compress'

let response = new Response(JSON.stringify(data), {
	headers: { 'Content-Type': 'application/json' },
})
let compressed = await compressResponse(response, request)
```

Compression is automatically skipped for:

- Responses with no `Accept-Encoding` header
- Responses that are already compressed (existing `Content-Encoding`)
- Responses with `Cache-Control: no-transform`
- Responses with `Content-Length` below threshold (default: 1024 bytes)
- Responses with range support (`Accept-Ranges: bytes`)
- 206 Partial Content responses
- HEAD requests (only headers are modified)

## Options

```ts
await compressResponse(response, request, {
	// Minimum size in bytes to compress (only enforced if Content-Length is present).
	// Default: 1024
	threshold: 1024,

	// Which encodings the server supports for negotiation.
	// Defaults to ['br', 'gzip', 'deflate']
	encodings: ['br', 'gzip', 'deflate'],

	// node:zlib options for gzip/deflate compression.
	// For SSE responses (text/event-stream), flush: Z_SYNC_FLUSH
	// is automatically applied unless you explicitly set a flush value.
	// See: https://nodejs.org/api/zlib.html#class-options
	zlib: {
		level: 6,
	},

	// node:zlib options for Brotli compression.
	// For SSE responses (text/event-stream), flush: BROTLI_OPERATION_FLUSH
	// is automatically applied unless you explicitly set a flush value.
	// See: https://nodejs.org/api/zlib.html#class-brotlioptions
	brotli: {
		params: {
			[zlib.constants.BROTLI_PARAM_QUALITY]: 4,
		},
	},
})
```

## Range requests and compression

Range requests and compression are mutually exclusive. When
`Accept-Ranges: bytes` is present in the response headers, `compressResponse`
will not compress the response. This is why the `createFileResponse` helper
enables ranges only for non-compressible MIME types by default - to allow
text-based assets to be compressed while still supporting resumable downloads
for media files.

## Navigation

- [Response overview](./index.md)
- [Related packages](./related.md)
- [Remix package index](../index.md)
