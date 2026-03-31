# Advanced usage

Source: https://github.com/remix-run/remix/tree/main/packages/node-fetch-server

## Low-level API

For more control over request/response handling, use the low-level API:

```ts
import * as http from 'node:http'
import { createRequest, sendResponse } from '@remix-run/node-fetch-server'

let server = http.createServer(async (req, res) => {
	// Convert Node.js request to Fetch API Request
	let request = createRequest(req, res, { host: process.env.HOST })

	try {
		// Add custom headers or middleware logic
		let startTime = Date.now()

		// Process the request with your handler
		let response = await handler(request)

		// Add response timing header
		let duration = Date.now() - startTime
		response.headers.set('X-Response-Time', `${duration}ms`)

		// Send the response
		await sendResponse(res, response)
	} catch (error) {
		console.error('Server error:', error)
		res.writeHead(500, { 'Content-Type': 'text/plain' })
		res.end('Internal Server Error')
	}
})

server.listen(3000)
```

The low-level API provides:

- `createRequest(req, res, options)` - Converts Node.js IncomingMessage to web
  Request
- `sendResponse(res, response)` - Sends web Response using Node.js
  ServerResponse

This is useful for:

- Building custom middleware systems
- Integrating with existing Node.js code
- Implementing custom error handling
- Performance-critical applications

## Navigation

- [node-fetch-server overview](./index.md)
- [Migration from Express](./migration.md)
- [Remix package index](../index.md)
