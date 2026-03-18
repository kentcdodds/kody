# multipart-parser

Source: https://github.com/remix-run/remix/tree/main/packages/multipart-parser

## Overview

`multipart-parser` is a fast, streaming multipart parser that works in any
JavaScript environment. Whether you're handling file uploads, parsing email
attachments, or working with multipart API responses, `multipart-parser` has you
covered.

## Why multipart-parser?

- **Universal JavaScript** - One library that works everywhere: Node.js, Bun,
  Deno, Cloudflare Workers, and browsers
- **Blazing Fast** - Outperforms popular alternatives like busboy in benchmarks
- **Zero Dependencies** - Lightweight and secure with no external dependencies
- **Memory Efficient** - Streaming architecture that yields files as they are
  found in the stream
- **Type Safe** - Written in TypeScript with comprehensive type definitions
- **Standards Based** - Built on the web Streams API for maximum compatibility
- **Production Ready** - Battle-tested error handling with specific error types

## Installation

```sh
bun add @remix-run/multipart-parser
```

## Usage

The most common use case is handling file uploads when you're building a web
server. The `parseMultipartRequest` function validates the request, extracts the
multipart boundary from the `Content-Type` header, parses all fields and files
in the `request.body` stream, and gives each one to you as a `MultipartPart`
object.

```ts
import {
	MultipartParseError,
	parseMultipartRequest,
} from '@remix-run/multipart-parser'

async function handleRequest(request: Request): void {
	try {
		for await (let part of parseMultipartRequest(request)) {
			if (part.isFile) {
				// Access file data in multiple formats
				let buffer = part.arrayBuffer // ArrayBuffer
				console.log(
					`File received: ${part.filename} (${buffer.byteLength} bytes)`,
				)
				console.log(`Content type: ${part.mediaType}`)
				console.log(`Field name: ${part.name}`)

				// Save to disk, upload to cloud storage, etc.
				await saveFile(part.filename, part.bytes)
			} else {
				let text = part.text // string
				console.log(`Field received: ${part.name} = ${JSON.stringify(text)}`)
			}
		}
	} catch (error) {
		if (error instanceof MultipartParseError) {
			console.error('Failed to parse multipart request:', error.message)
		} else {
			console.error('An unexpected error occurred:', error)
		}
	}
}
```

## Navigation

- [Limits and Node bindings](./limits-and-node.md)
- [Low-level APIs](./low-level.md)
- [Benchmarks and related packages](./benchmarks.md)
- [Remix package index](../index.md)
