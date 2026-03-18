# session-storage-redis

Source:
https://github.com/remix-run/remix/tree/main/packages/session-storage-redis

## README

Redis-backed session storage for `remix/session`.

## Installation

```sh
npm i remix redis
```

## Usage

```ts
import { createClient } from 'redis'
import { createRedisSessionStorage } from 'remix/session-storage-redis'

let redis = createClient({ url: process.env.REDIS_URL })
await redis.connect()

let sessionStorage = createRedisSessionStorage(redis, {
	keyPrefix: 'session:',
	ttl: 60 * 60 * 24,
})
```

## Options

- `keyPrefix` (`string`, default: `'session:'`)
- `ttl` (`number` in seconds)
- `useUnknownIds` (`boolean`, default: `false`)

## License

See [LICENSE](https://github.com/remix-run/remix/blob/main/LICENSE)

## Navigation

- [Remix package index](./index.md)
