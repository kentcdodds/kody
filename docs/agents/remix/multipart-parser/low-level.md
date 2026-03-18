# Low-level APIs

Source: https://github.com/remix-run/remix/tree/main/packages/multipart-parser

## Low-level API

If you're working directly with multipart boundaries and buffers/streams of
multipart data that are not necessarily part of a request, `multipart-parser`
provides a low-level `parseMultipart()` API that you can use directly:

```ts
import { parseMultipart } from '@remix-run/multipart-parser'

let message = new Uint8Array(/* ... */)
let boundary = '----WebKitFormBoundary56eac3x'

for (let part of parseMultipart(message, { boundary })) {
	// ...
}
```

In addition, the `parseMultipartStream` function provides an async generator
interface for multipart data in a `ReadableStream`:

```ts
import { parseMultipartStream } from '@remix-run/multipart-parser'

let message = new ReadableStream(/* ... */)
let boundary = '----WebKitFormBoundary56eac3x'

for await (let part of parseMultipartStream(message, { boundary })) {
	// ...
}
```

## Navigation

- [multipart-parser overview](./index.md)
- [Benchmarks and related packages](./benchmarks.md)
- [Remix package index](../index.md)
