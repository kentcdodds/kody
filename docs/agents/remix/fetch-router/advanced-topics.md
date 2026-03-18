# Additional topics and HTML helpers

Source: https://github.com/remix-run/remix/tree/main/packages/fetch-router

## Additional topics

### Scaling your application

- how to use a TrieMatcher
- how to spread controllers across multiple files

### Error handling and aborted requests

- wrap `router.fetch()` in a try/catch to handle errors
- `AbortError` is thrown when a request is aborted

### Content negotiation

- use `Accept.from()` from `@remix-run/headers` to serve different responses
  based on the client's `Accept` header
  - maybe put this on `context.accepts()` for convenience?

### Sessions

- use a custom `sessionStorage` implementation to store session data
- use `session.get()` and `session.set()` to get and set session data
- use `session.flash()` to set a flash message
- use `session.destroy()` to destroy the session

### Form data and file uploads

- use the `formData()` middleware to parse the `FormData` object from the
  request body
- use the `formData` property of the context object to access the form data
- use the `files` property of the context object to access the uploaded files
- use the `uploadHandler` option of the `formData()` middleware to handle file
  uploads

### Request method override

- use the `methodOverride()` middleware to override the request method
- use a hidden `<input name="_method" value="...">` to override the request
  method

## Response helpers

Response helpers for creating common HTTP responses are available in the
[`@remix-run/response`](https://github.com/remix-run/remix/tree/main/packages/response)
package:

```tsx
import { createFileResponse } from '@remix-run/response/file'
import { createHtmlResponse } from '@remix-run/response/html'
import { createRedirectResponse } from '@remix-run/response/redirect'
import { compressResponse } from '@remix-run/response/compress'

let response = createHtmlResponse('<h1>Hello</h1>')
let response = Response.json({ message: 'Hello' })
let response = createRedirectResponse('/')
let response = compressResponse(uncompressedResponse, request)
```

See the
[`@remix-run/response` documentation](https://github.com/remix-run/remix/tree/main/packages/response#readme)
for more details.

## Working with HTML

For working with HTML strings and safe HTML interpolation, see the
[`@remix-run/html-template`](https://github.com/remix-run/remix/tree/main/packages/html-template)
package. It provides a `html` template tag with automatic escaping to prevent
XSS vulnerabilities.

```ts
import { html } from '@remix-run/html-template'
import { createHtmlResponse } from '@remix-run/response/html'

// Use the template tag to escape unsafe variables in HTML.
let unsafe = '<script>alert(1)</script>'
let response = createHtmlResponse(html`<h1>${unsafe}</h1>`, { status: 400 })
```

The `html.raw` template tag can be used to interpolate values without escaping
them. This has the same semantics as `String.raw` but for HTML snippets that
have already been escaped or are from trusted sources:

```ts
// Use html.raw as a template tag to skip escaping interpolations
let safeHtml = '<b>Bold</b>'
let content = html.raw`<div class="content">${safeHtml}</div>`
let response = createHtmlResponse(content)

// This is particularly useful when building HTML from multiple safe fragments
let header = '<header>Title</header>'
let body = '<main>Content</main>'
let footer = '<footer>Footer</footer>'
let page = html.raw`
  <!DOCTYPE html>
  <html>
    <body>
      ${header}
      ${body}
      ${footer}
    </body>
  </html>
`

// You can nest html.raw inside html to preserve SafeHtml fragments
let icon = html.raw`<svg>...</svg>`
let button = html`<button>${icon} Click me</button>` // icon is not escaped
```

**Warning**: Only use `html.raw` with trusted content. Unlike the regular `html`
template tag, `html.raw` does not escape its interpolations, which can lead to
XSS vulnerabilities if used with untrusted user input.

See the
[`@remix-run/html-template` documentation](https://github.com/remix-run/remix/tree/main/packages/html-template#readme)
for more details.

## Navigation

- [fetch-router overview](./index.md)
- [Middleware and request context](./middleware.md)
- [Remix package index](../index.md)
