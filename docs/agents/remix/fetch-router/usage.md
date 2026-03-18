# Basic usage and route maps

Source: https://github.com/remix-run/remix/tree/main/packages/fetch-router

The main purpose of the router is to map incoming requests to request handlers
and middleware. The router uses the `fetch()` API to accept a
[`Request`](https://developer.mozilla.org/en-US/docs/Web/API/Request) and return
a [`Response`](https://developer.mozilla.org/en-US/docs/Web/API/Response).

The example below is a small site with a home page, an "about" page, and a blog.

```ts
import { createRouter } from 'remix/fetch-router'
import { route } from 'remix/fetch-router/routes'
import { logger } from 'remix/logger-middleware'

// `route()` creates a "route map" that organizes routes by name. The keys
// of the map may be any name, and may be nested to group related routes.
let routes = route({
	home: '/',
	about: '/about',
	blog: {
		index: '/blog',
		show: '/blog/:slug',
	},
})

let router = createRouter({
	// Middleware may be used to run code before and/or after actions run.
	// In this case, the `logger()` middleware logs the request to the console.
	middleware: [logger()],
})

// Map the routes to a "controller" that defines actions for each route. The
// structure of the controller mirrors the structure of the route map.
router.map(routes, {
	home() {
		return new Response('Home')
	},
	about() {
		return new Response('About')
	},
	blog: {
		index() {
			return new Response('Blog')
		},
		show({ params }) {
			// params is a type-safe object with the parameters from the route pattern
			return new Response(`Post ${params.slug}`)
		},
	},
})

let response = await router.fetch('https://remix.run/blog/hello-remix')
console.log(await response.text()) // "Post hello-remix"
```

The route map is an object of the same shape as the object passed into
`route()`, including nested objects. The leaves of the map are `Route` objects,
which you can see if you inspect the type of the `routes` variable in your IDE.

```ts
type Routes = typeof routes
// {
//   home: Route<'ANY', '/'>
//   about: Route<'ANY', '/about'>
//   blog: {
//     index: Route<'ANY', '/blog'>
//     show: Route<'ANY', '/blog/:slug'>
//   },
// }
```

The `routes.home` route is a `Route<'ANY', '/'>`, which means it serves any
request method (`GET`, `POST`, `PUT`, `DELETE`, etc.) when the URL path is `/`.
We'll discuss routing based on request method in the routing guide.

## Links and form actions

In addition to describing the structure of your routes, route maps also make it
easy to generate type-safe links and form actions using the `href()` function on
a route. The example below is a small site with a home page and a "Contact Us"
page.

Note: We're using the
[`createHtmlResponse` helper from `remix/response`](https://github.com/remix-run/remix/tree/main/packages/response/README.md#html-responses)
below to create `Response`s with `Content-Type: text/html`. We're also using the
`html` template tag to create safe HTML strings to use in the response body.

```ts
import { createRouter } from 'remix/fetch-router'
import { route } from 'remix/fetch-router/routes'
import { html } from 'remix/html-template'
import { createHtmlResponse } from 'remix/response/html'

let routes = route({
	home: '/',
	contact: '/contact',
})

let router = createRouter()

// Register an action for `GET /`
router.get(routes.home, () => {
	return createHtmlResponse(`
    <html>
      <body>
        <h1>Home</h1>
        <p>
          <a href="${routes.contact.href()}">Contact Us</a>
        </p>
      </body>
    </html>
  `)
})

// Register an action for `GET /contact`
router.get(routes.contact, () => {
	return createHtmlResponse(`
    <html>
      <body>
        <h1>Contact Us</h1>
        <form method="POST" action="${routes.contact.href()}">
          <div>
            <label for="message">Message</label>
            <input type="text" name="message" />
          </div>
          <button type="submit">Send</button>
        </form>
        <footer>
          <p>
            <a href="${routes.home.href()}">Home</a>
          </p>
        </footer>
      </body>
    </html>
  `)
})

// Register an action for `POST /contact`
router.post(routes.contact, ({ formData }) => {
	// POST actions receive a `context` object with a `formData` property that
	// contains the `FormData` from the form submission. It is automatically
	// parsed from the request body and available in all POST actions.
	let message = formData.get('message') as string
	let body = html`
		<html>
			<body>
				<h1>Thanks!</h1>
				<div>
					<p>You said: ${message}</p>
				</div>
				<footer>
					<p>
						<a href="${routes.home.href()}">Home</a>
					</p>
				</footer>
			</body>
		</html>
	`

	return createHtmlResponse(body)
})
```

## Navigation

- [fetch-router overview](./index.md)
- [Routing based on request method](./routing-methods.md)
- [Remix package index](../index.md)
