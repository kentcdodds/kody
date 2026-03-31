# Raw header parsing

Source: https://github.com/remix-run/remix/tree/main/packages/headers

## Raw headers

Parse and stringify raw HTTP header strings.

```ts
import { parse, stringify } from '@remix-run/headers'

let headers = parse('Content-Type: text/html\\r\\nCache-Control: no-cache')
headers.get('content-type') // 'text/html'
headers.get('cache-control') // 'no-cache'

stringify(headers)
// 'Content-Type: text/html\\r\\nCache-Control: no-cache'
```

## Related packages

- [`fetch-proxy`](https://github.com/remix-run/remix/tree/main/packages/fetch-proxy) -
  Build HTTP proxy servers using the web fetch API
- [`node-fetch-server`](https://github.com/remix-run/remix/tree/main/packages/node-fetch-server) -
  Build HTTP servers on Node.js using the web fetch API

## License

See [LICENSE](https://github.com/remix-run/remix/blob/main/LICENSE)

## Navigation

- [Headers overview](./index.md)
- [Remix package index](../index.md)
