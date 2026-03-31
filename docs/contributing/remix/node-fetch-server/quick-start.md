# Quick start

Source: https://github.com/remix-run/remix/tree/main/packages/node-fetch-server

## Basic server

```ts
import * as http from 'node:http'
import { createRequestListener } from '@remix-run/node-fetch-server'

// Example: Simple in-memory user storage
let users = new Map([
	['1', { id: '1', name: 'Alice', email: 'alice@example.com' }],
	['2', { id: '2', name: 'Bob', email: 'bob@example.com' }],
])

async function handler(request: Request) {
	let url = new URL(request.url)

	// GET / - Home page
	if (url.pathname === '/' && request.method === 'GET') {
		return new Response('Welcome to the User API! Try GET /api/users')
	}

	// GET /api/users - List all users
	if (url.pathname === '/api/users' && request.method === 'GET') {
		return Response.json(Array.from(users.values()))
	}

	// GET /api/users/:id - Get specific user
	let userMatch = url.pathname.match(/^\\/api\\/users\\/(\\w+)$/)
	if (userMatch && request.method === 'GET') {
		let user = users.get(userMatch[1])
		if (user) {
			return Response.json(user)
		}
		return new Response('User not found', { status: 404 })
	}

	return new Response('Not Found', { status: 404 })
}

// Create a standard Node.js server
let server = http.createServer(createRequestListener(handler))

server.listen(3000, () => {
	console.log('Server running at http://localhost:3000')
})
```

## Working with request data

```ts
async function handler(request: Request) {
	let url = new URL(request.url)

	// Handle JSON data
	if (request.method === 'POST' && url.pathname === '/api/users') {
		try {
			let userData = await request.json()

			// Validate required fields
			if (!userData.name || !userData.email) {
				return Response.json(
					{ error: 'Name and email are required' },
					{ status: 400 },
				)
			}

			// Create user (your implementation)
			let newUser = {
				id: Date.now().toString(),
				...userData,
			}

			return Response.json(newUser, { status: 201 })
		} catch (error) {
			return Response.json({ error: 'Invalid JSON' }, { status: 400 })
		}
	}

	// Handle URL search params
	if (url.pathname === '/api/search') {
		let query = url.searchParams.get('q')
		let limit = parseInt(url.searchParams.get('limit') || '10')

		return Response.json({
			query,
			limit,
			results: [], // Your search results here
		})
	}

	return new Response('Not Found', { status: 404 })
}
```

## Streaming responses

```ts
async function handler(request: Request) {
	if (request.url.endsWith('/stream')) {
		// Create a streaming response
		let stream = new ReadableStream({
			async start(controller) {
				for (let i = 0; i < 5; i++) {
					controller.enqueue(new TextEncoder().encode(`Chunk ${i}\\n`))
					await new Promise((resolve) => setTimeout(resolve, 1000))
				}
				controller.close()
			},
		})

		return new Response(stream, {
			headers: { 'Content-Type': 'text/plain' },
		})
	}

	return new Response('Not Found', { status: 404 })
}
```

## Custom hostname configuration

```ts
import * as http from 'node:http'
import { createRequestListener } from '@remix-run/node-fetch-server'

// Use a custom hostname (e.g., from environment variable)
let hostname = process.env.HOST || 'api.example.com'

async function handler(request: Request) {
	// request.url will now use your custom hostname
	console.log(request.url) // https://api.example.com/path

	return Response.json({
		message: 'Hello from custom domain!',
		url: request.url,
	})
}

let server = http.createServer(
	createRequestListener(handler, { host: hostname }),
)

server.listen(3000)
```

## Accessing client information

```ts
import { type FetchHandler } from '@remix-run/node-fetch-server'

let handler: FetchHandler = async (request, client) => {
	// Log client information
	console.log(`Request from ${client.address}:${client.port}`)

	// Use for rate limiting, geolocation, etc.
	if (isRateLimited(client.address)) {
		return new Response('Too Many Requests', { status: 429 })
	}

	return Response.json({
		message: 'Hello!',
		yourIp: client.address,
	})
}
```

## HTTPS support

```ts
import * as https from 'node:https'
import * as fs from 'node:fs'
import { createRequestListener } from '@remix-run/node-fetch-server'

let options = {
	key: fs.readFileSync('private-key.pem'),
	cert: fs.readFileSync('certificate.pem'),
}

let server = https.createServer(options, createRequestListener(handler))

server.listen(443, () => {
	console.log('HTTPS Server running on port 443')
})
```

## Navigation

- [node-fetch-server overview](./index.md)
- [Advanced usage](./advanced-usage.md)
- [Remix package index](../index.md)
