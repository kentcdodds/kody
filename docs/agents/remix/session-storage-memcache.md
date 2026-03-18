# session-storage-memcache

Source:
https://github.com/remix-run/remix/tree/main/packages/session-storage-memcache

## README

Memcache session storage for `remix/session`.

## Installation

```sh
npm i remix
```

## Usage

```ts
import { createMemcacheSessionStorage } from 'remix/session-storage-memcache'

let sessionStorage = createMemcacheSessionStorage('127.0.0.1:11211', {
	keyPrefix: 'my-app:session:',
	ttlSeconds: 60 * 60 * 24 * 7,
})
```

## Options

- `useUnknownIds` (`boolean`, default: `false`)
- `keyPrefix` (`string`, default: `'remix:session:'`)
- `ttlSeconds` (`number`, default: `0`)

Memcache storage uses TCP sockets and therefore requires a Node.js runtime.

## Related packages

- [`session`](https://github.com/remix-run/remix/tree/main/packages/session)
- [`session-middleware`](https://github.com/remix-run/remix/tree/main/packages/session-middleware)

## License

See [LICENSE](https://github.com/remix-run/remix/blob/main/LICENSE)

## Navigation

- [Remix package index](./index.md)
