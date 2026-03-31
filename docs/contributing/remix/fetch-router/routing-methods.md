# Routing based on request method

Source: https://github.com/remix-run/remix/tree/main/packages/fetch-router

## Routing based on request method

In the example above, both the `home` and `contact` routes are able to be
registered for any incoming
[`request.method`](https://developer.mozilla.org/en-US/docs/Web/API/Request/method).
If you inspect their types, you'll see:

```tsx
type HomeRoute = typeof routes.home // Route<'ANY', '/'>
type ContactRoute = typeof routes.contact // Route<'ANY', '/contact'>
```

We used `router.get()` and `router.post()` to register actions on each route
specifically for the `GET` and `POST` request methods.

However, we can also encode the request method into the route definition itself
using the `method` property on the route. When you include the `method` in the
route definition, `router.map()` will register the action only for that specific
request method. This can be more convenient than using `router.get()` and
`router.post()` to register actions one at a time.

```ts
import * as assert from 'node:assert/strict'
import { createRouter } from 'remix/fetch-router'
import { route } from 'remix/fetch-router/routes'

let routes = route({
	home: { method: 'GET', pattern: '/' },
	contact: {
		index: { method: 'GET', pattern: '/contact' },
		action: { method: 'POST', pattern: '/contact' },
	},
})

type Routes = typeof routes
// Each route is now typed with a specific request method.
// {
//   home: Route<'GET', '/'>,
//   contact: {
//     index: Route<'GET', '/contact'>,
//     action: Route<'POST', '/contact'>,
//   },
// }

let router = createRouter()

router.map(routes, {
	home({ method }) {
		assert.equal(method, 'GET')
		return new Response('Home')
	},
	contact: {
		index({ method }) {
			assert.equal(method, 'GET')
			return new Response('Contact')
		},
		action({ method }) {
			assert.equal(method, 'POST')
			return new Response('Contact Action')
		},
	},
})
```

## Declaring routes

In additon to the `{ method, pattern }` syntax shown above, the router provides
a few shorthand methods that help to eliminate some of the boilerplate when
building complex route maps:

- [`form`](#declaring-form-routes) - creates a route map with an `index` (`GET`)
  and `action` (`POST`) route. This is well-suited to showing a standard HTML
  `<form>` and handling its submit action at the same URL.
- [`resources` (and `resource`)](./routing-resources.md) - creates a route map
  with a set of resource-based routes, useful when defining RESTful API routes
  or
  [Rails-style resource-based routes](https://guides.rubyonrails.org/routing.html#resource-routing-the-rails-default).

### Declaring form routes

Continuing with the contact page example, let's use the `form` shorthand to make
the route map a little less verbose.

A `form()` route map contains two routes: `index` and `action`. The `index`
route is a `GET` route that shows the form, and the `action` route is a `POST`
route that handles the form submission.

```tsx
import { createRouter } from 'remix/fetch-router'
import { form, route } from 'remix/fetch-router/routes'
import { createHtmlResponse } from 'remix/response/html'
import { html } from 'remix/html-template'

let routes = route({
	home: '/',
	contact: form('contact'),
})

type Routes = typeof routes
// {
//   home: Route<'ANY', '/'>
//   contact: {
//     index: Route<'GET', '/contact'> - Shows the form
//     action: Route<'POST', '/contact'> - Handles the form submission
//   },
// }

let router = createRouter()

router.map(routes, {
	home() {
		return createHtmlResponse(`
      <html>
        <body>
          <h1>Home</h1>
          <footer>
            <p>
              <a href="${routes.contact.index.href()}">Contact Us</a>
            </p>
          </footer>
        </body>
      </html>
    `)
	},
	contact: {
		// GET /contact - shows the form
		index() {
			return createHtmlResponse(`
        <html>
          <body>
            <h1>Contact Us</h1>
            <form method="POST" action="${routes.contact.action.href()}">
              <label for="message">Message</label>
              <input type="text" name="message" />
              <button type="submit">Send</button>
            </form>
          </body>
        </html>
      `)
		},
		// POST /contact - handles the form submission
		action({ formData }) {
			let message = formData.get('message') as string
			let body = html`
				<html>
					<body>
						<h1>Thanks!</h1>
						<p>You said: ${message}</p>

						<p>
							Got more to say?
							<a href="${routes.contact.index.href()}">Send another message</a>
						</p>
					</body>
				</html>
			`

			return createHtmlResponse(body)
		},
	},
})
```

## Navigation

- [Resource-based routes](./routing-resources.md)
- [Basic usage and route maps](./usage.md)
- [fetch-router overview](./index.md)
- [Remix package index](../index.md)
