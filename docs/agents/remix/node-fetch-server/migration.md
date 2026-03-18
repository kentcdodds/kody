# Migration from Express

Source: https://github.com/remix-run/remix/tree/main/packages/node-fetch-server

## Basic routing

```ts
// Express
let app = express()

app.get('/users/:id', async (req, res) => {
	let user = await db.getUser(req.params.id)
	if (!user) {
		return res.status(404).json({ error: 'User not found' })
	}
	res.json(user)
})

app.listen(3000)

// node-fetch-server
import { createRequestListener } from '@remix-run/node-fetch-server'

async function handler(request: Request) {
	let url = new URL(request.url)
	let match = url.pathname.match(/^\\/users\\/(\\w+)$/)

	if (match && request.method === 'GET') {
		let user = await db.getUser(match[1])
		if (!user) {
			return Response.json({ error: 'User not found' }, { status: 404 })
		}
		return Response.json(user)
	}

	return new Response('Not Found', { status: 404 })
}

http.createServer(createRequestListener(handler)).listen(3000)
```

## Navigation

- [node-fetch-server overview](./index.md)
- [Demos and benchmark](./demos-and-benchmark.md)
- [Remix package index](../index.md)
