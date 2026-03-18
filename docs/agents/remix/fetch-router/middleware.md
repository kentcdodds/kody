# Middleware and request context

Source: https://github.com/remix-run/remix/tree/main/packages/fetch-router

## Controllers and middleware

Middleware functions run code before and/or after actions. They are a powerful
way to add functionality to your app.

A basic logging middleware might look like this:

```ts
import type { Middleware } from 'remix/fetch-router'

// You can use the `Middleware` type to type middleware functions.
function logger(): Middleware {
	return async (context, next) => {
		let start = new Date()

		// Call next() to invoke the next middleware or action in the chain.
		let response = await next()

		let end = new Date()
		let duration = end.getTime() - start.getTime()

		console.log(
			`${context.request.method} ${context.request.url} ${response.status} ${duration}ms`,
		)

		return response
	}
}

// Use it like this:
let router = createRouter({
	middleware: [logger()],
})
```

Middleware is typically built as a function that returns a middleware function.
This allows you to pass options to the middleware function if needed. For
example, the `auth()` middleware below allows you to pass a `token` option that
is used to authenticate the request.

```tsx
interface AuthOptions {
	token: string
}

function auth(options?: AuthOptions): Middleware {
	let token = options?.token ?? 'secret'

	return (context, next) => {
		if (context.headers.get('Authorization') !== `Bearer ${token}`) {
			return new Response('Unauthorized', { status: 401 })
		}
		return next()
	}
}
```

Middleware may be used in two different contexts: globally (at the router level)
or inline (at the route level).

Global middleware is added to the router when it is created using the
`createRouter({ middleware })` option. This middleware runs before any routes
are matched and is useful for doing things like logging, serving static files,
profiling, and a variety of other things. Global middleware runs on every
request, so it's important to keep them lightweight and fast.

Inline (or "route") middleware is added to the router when actions are
registered using either `router.map()` or one of the method-specific helpers
like `router.get()`, `router.post()`, `router.put()`, `router.delete()`, etc.
Route middleware runs after global middleware but before the route action, and
is useful for doing things like authentication, authorization, and data
validation.

```tsx
let routes = route({
	home: '/',
	admin: {
		dashboard: '/admin/dashboard',
	},
})

let router = createRouter({
	// This middleware runs on all requests.
	middleware: [staticFiles('./public')],
})

router.map(routes.home, () => new Response('Home'))

router.map(routes.admin.dashboard, {
	// This middleware runs only on the `/admin/dashboard` route.
	middleware: [auth({ token: 'secret' })],
	action() {
		return new Response('Dashboard')
	},
})
```

## Request context

Every action and middleware receives a `context` object with useful properties:

```ts
router.get('/posts/:id', ({ request, url, params, storage }) => {
	// request: The original Request object
	console.log(request.method) // "GET"
	console.log(request.headers.get('Accept'))

	// url: Parsed URL object
	console.log(url.pathname) // "/posts/123"
	console.log(url.searchParams.get('sort'))

	// params: Route parameters (fully typed!)
	console.log(params.id) // "123"

	// storage: AppStorage for type-safe access to request-scoped data
	storage.set('user', currentUser)

	return new Response(`Post ${params.id}`)
})
```

## Navigation

- [fetch-router overview](./index.md)
- [Routing based on request method](./routing-methods.md)
- [Remix package index](../index.md)
