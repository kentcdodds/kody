# Resource-based routes

Source: https://github.com/remix-run/remix/tree/main/packages/fetch-router

## Resource-based routes

The router provides a `resources()` helper that creates a route map with a set
of resource-based routes, useful when defining RESTful API routes or modeling
resources in a web application (similar to Rails' `resources` helper).

```ts
import { createRouter } from 'remix/fetch-router'
import { resources, route } from 'remix/fetch-router/routes'

let routes = route({
	brands: {
		...resources('brands', { only: ['index', 'show'] }),
		products: resources('brands/:brandId/products', {
			only: ['index', 'show'],
		}),
	},
})

type Routes = typeof routes
// {
//   brands: {
//     index: Route<'GET', '/brands'>
//     show: Route<'GET', '/brands/:id'>
//     products: {
//       index: Route<'GET', '/brands/:brandId/products'>
//       show: Route<'GET', '/brands/:brandId/products/:id'>
//     },
//   },
// }

let router = createRouter()

router.map(routes.brands, {
	// GET /brands
	index() {
		return new Response('Brands Index')
	},
	// GET /brands/:id
	show({ params }) {
		return new Response(`Brand ${params.id}`)
	},
	products: {
		// GET /brands/:brandId/products
		index() {
			return new Response('Products Index')
		},
		// GET /brands/:brandId/products/:id
		show({ params }) {
			return new Response(`Brand ${params.brandId}, Product ${params.id}`)
		},
	},
})
```

The `resource()` helper creates a route map for a single resource (not something
that is part of a collection). This is useful when defining operations on a
singleton resource, like a user profile.

```tsx
import { createRouter } from 'remix/fetch-router'
import { resource, resources, route } from 'remix/fetch-router/routes'

let routes = route({
	user: {
		...resources('users', { only: ['index', 'show'] }),
		profile: resource('users/:userId/profile', {
			only: ['show', 'edit', 'update'],
		}),
	},
})

type Routes = typeof routes
// {
//   user: {
//     index: Route<'GET', '/users'>
//     show: Route<'GET', '/users/:id'>
//     profile: {
//       show: Route<'GET', '/users/:userId/profile'>
//       edit: Route<'GET', '/users/:userId/profile/edit'>
//       update: Route<'PUT', '/users/:userId/profile'>
//     },
//   },
// }
```

Without the `only` option, a `resources('users')` route map contains 7 routes:
`index`, `new`, `show`, `create`, `edit`, `update`, and `destroy`.

```tsx
let routes = resources('users')
type Routes = typeof routes
// {
//   index: Route<'GET', '/users'> - Lists all users
//   new: Route<'GET', '/users/new'> - Shows a form to create a new user
//   show: Route<'GET', '/users/:id'> - Shows a single user
//   create: Route<'POST', '/users'> - Creates a new user
//   edit: Route<'GET', '/users/:id/edit'> - Shows a form to edit a user
//   update: Route<'PUT', '/users/:id'> - Updates a user
//   destroy: Route<'DELETE', '/users/:id'> - Deletes a user
// }
```

Similarly, a `resource('profile')` route map contains 6 routes: `new`, `show`,
`create`, `edit`, `update`, and `destroy`. There is no `index` route because a
`resource()` represents a singleton resource, not a collection, so there is no
collection view.

```tsx
let routes = resource('profile')
type Routes = typeof routes
// {
//   new: Route<'GET', '/profile/new'> - Shows a form to create the profile
//   show: Route<'GET', '/profile'> - Shows the profile
//   create: Route<'POST', '/profile'> - Creates the profile
//   edit: Route<'GET', '/profile/edit'> - Shows a form to edit the profile
//   update: Route<'PUT', '/profile'> - Updates the profile
//   destroy: Route<'DELETE', '/profile'> - Deletes the profile
// }
```

Resource route names may be customized using the `names` option when you'd
prefer not to use the default
`index`/`new`/`show`/`create`/`edit`/`update`/`destroy` route names.

```tsx
import { createRouter } from 'remix/fetch-router'
import { resources, route } from 'remix/fetch-router/routes'

let routes = route({
	users: resources('users', {
		only: ['index', 'show'],
		names: { index: 'list', show: 'view' },
	}),
})
type Routes = typeof routes.users
// {
//   list: Route<'GET', '/users'> - Lists all users
//   view: Route<'GET', '/users/:id'> - Shows a single user
// }
```

If you want to use a param name other than `id`, you can use the `param` option.

```tsx
import { createRouter } from 'remix/fetch-router'
import { resources, route } from 'remix/fetch-router/routes'

let routes = route({
	users: resources('users', {
		only: ['index', 'show', 'edit', 'update'],
		param: 'userId',
	}),
})
type Routes = typeof routes.users
// {
//   index: Route<'GET', '/users'> - Lists all users
//   show: Route<'GET', '/users/:userId'> - Shows a single user
//   edit: Route<'GET', '/users/:userId/edit'> - Shows a form to edit a user
//   update: Route<'PUT', '/users/:userId'> - Updates a user
// }
```

You can use the `exclude` option to exclude routes from being generated.

```tsx
let routes = resources('users', { exclude: ['edit', 'update', 'destroy'] })
type Routes = typeof routes
// {
//   index: Route<'GET', '/users'> - Lists all users
//   new: Route<'GET', '/users/new'> - Shows a form to create a new user
//   show: Route<'GET', '/users/:userId'> - Shows a single user
//   create: Route<'POST', '/users'> - Creates a new user
// }
```

## Navigation

- [Routing based on request method](./routing-methods.md)
- [Basic usage and route maps](./usage.md)
- [fetch-router overview](./index.md)
- [Remix package index](../index.md)
