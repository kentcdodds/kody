# Limits and Node bindings

Source: https://github.com/remix-run/remix/tree/main/packages/multipart-parser

## Limiting file upload size

You can set a file upload size limit using the `maxFileSize` option, and return
a 413 "Payload Too Large" response when you receive a request that exceeds the
limit.

```ts
import {
	MultipartParseError,
	MaxFileSizeExceededError,
	parseMultipartRequest,
} from '@remix-run/multipart-parser/node'

const oneMb = Math.pow(2, 20)
const maxFileSize = 10 * oneMb

async function handleRequest(request: Request): Promise<Response> {
	try {
		for await (let part of parseMultipartRequest(request, { maxFileSize })) {
			// ...
		}
	} catch (error) {
		if (error instanceof MaxFileSizeExceededError) {
			return new Response('File size limit exceeded', { status: 413 })
		} else if (error instanceof MultipartParseError) {
			return new Response('Failed to parse multipart request', { status: 400 })
		} else {
			console.error(error)
			return new Response('Internal Server Error', { status: 500 })
		}
	}
}
```

## Node.js bindings

The main module (`import from "@remix-run/multipart-parser"`) assumes you're
working with the Fetch API (`Request`, `ReadableStream`, etc). Support for these
interfaces was added to Node.js by the undici project in version 16.5.0.

If you're building a server for Node.js that relies on node-specific APIs like
`http.IncomingMessage`, `stream.Readable`, and `buffer.Buffer`,
`multipart-parser` ships with an additional module that works directly with
these APIs.

```ts
import * as http from 'node:http'
import {
	MultipartParseError,
	parseMultipartRequest,
} from '@remix-run/multipart-parser/node'

let server = http.createServer(async (req, res) => {
	try {
		for await (let part of parseMultipartRequest(req)) {
			// ...
		}
	} catch (error) {
		if (error instanceof MultipartParseError) {
			console.error('Failed to parse multipart request:', error.message)
		} else {
			console.error('An unexpected error occurred:', error)
		}
	}
})

server.listen(8080)
```

## Navigation

- [multipart-parser overview](./index.md)
- [Low-level APIs](./low-level.md)
- [Remix package index](../index.md)
