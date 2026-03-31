# Redirect responses

Source: https://github.com/remix-run/remix/tree/main/packages/response

The `createRedirectResponse` helper creates redirect responses. The main
improvements over the native `Response.redirect` API are:

- Accepts a relative `location` instead of a full URL.
- Accepts a `ResponseInit` object as the second argument, allowing you to set
  additional headers and status code.

```ts
import { createRedirectResponse } from '@remix-run/response/redirect'

// Default 302 redirect
let response = createRedirectResponse('/login')

// Custom status code
let response = createRedirectResponse('/new-page', 301)

// With additional headers
let response = createRedirectResponse('/dashboard', {
	status: 303,
	headers: { 'X-Redirect-Reason': 'authentication' },
})
```

## Navigation

- [Response overview](./index.md)
- [Compressed responses](./compress-responses.md)
- [Remix package index](../index.md)
