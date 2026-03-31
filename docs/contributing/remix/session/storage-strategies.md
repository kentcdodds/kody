# Storage strategies

Source: https://github.com/remix-run/remix/tree/main/packages/session

Several strategies are provided out of the box for storing session data across
requests, depending on your needs.

A session storage object must always be initialized with a signed session
cookie. This is used to identify the session and to store the session data in
the response.

## Filesystem storage

Filesystem storage is a good choice for production environments. It requires
access to a persistent filesystem, which is readily available on most servers.
And it can scale to handle sessions with a lot of data easily.

```ts
import { createFsSessionStorage } from '@remix-run/session/fs-storage'

let sessionStorage = createFsSessionStorage('/tmp/sessions')
```

## Cookie storage

Cookie storage is suitable for production environments. In this strategy, all
session data is stored directly in the session cookie itself, which means it
doesn't require any additional storage.

The main limitation of cookie storage is that the total size of the session
cookie is limited to the browser's maximum cookie size, typically 4096 bytes.

```ts
import { createCookieSessionStorage } from '@remix-run/session/cookie-storage'

let sessionStorage = createCookieSessionStorage()
```

## Memory storage

Memory storage is useful in testing and development environments. In this
strategy, all session data is stored in memory, which means no additional
storage is required. However, all session data is lost when the server restarts.

```ts
import { createMemorySessionStorage } from '@remix-run/session/memory-storage'

let sessionStorage = createMemorySessionStorage()
```

## Navigation

- [Session overview](./index.md)
- [Related packages](./related.md)
- [Remix package index](../index.md)
