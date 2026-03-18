# HTML responses

Source: https://github.com/remix-run/remix/tree/main/packages/response

The `createHtmlResponse` helper creates HTML responses with proper
`Content-Type` and DOCTYPE handling:

```ts
import { createHtmlResponse } from '@remix-run/response/html'

let response = createHtmlResponse('<h1>Hello, World!</h1>')
// Content-Type: text/html; charset=UTF-8
// Body: <!DOCTYPE html><h1>Hello, World!</h1>
```

The helper automatically prepends `<!DOCTYPE html>` if not already present. It
works with strings, `SafeHtml` from `@remix-run/html-template`, Blobs/Files,
ArrayBuffers, and ReadableStreams.

```ts
import { html } from '@remix-run/html-template'
import { createHtmlResponse } from '@remix-run/response/html'

let name = '<script>alert(1)</script>'
let response = createHtmlResponse(html`<h1>Hello, ${name}!</h1>`)
// Safely escaped HTML
```

## Navigation

- [Response overview](./index.md)
- [Redirect responses](./redirect-responses.md)
- [Remix package index](../index.md)
