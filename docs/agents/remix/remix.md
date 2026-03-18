# remix

Source: https://github.com/remix-run/remix/tree/main/packages/remix

## README

A modern web framework for JavaScript.

See [remix.run](https://remix.run) for framework docs.

## Installation

```sh
npm i remix
```

## Package usage in Remix 3 alpha

The `remix` package is used through subpath imports.

- ✅ `import { createRouter } from 'remix/fetch-router'`
- ✅ `import { route } from 'remix/fetch-router/routes'`
- ✅ `import { createRoot } from 'remix/component'`
- ❌ `import { ... } from 'remix'` (root import removed in `3.0.0-alpha.3`)

## Subpath export surface (`3.0.0-alpha.3`)

Top-level package exports currently include:

- `remix/async-context-middleware`
- `remix/component`
- `remix/compression-middleware`
- `remix/cookie`
- `remix/data-schema`
- `remix/data-table`
- `remix/fetch-proxy`
- `remix/fetch-router`
- `remix/file-storage`
- `remix/file-storage-s3`
- `remix/form-data-middleware`
- `remix/form-data-parser`
- `remix/fs`
- `remix/headers`
- `remix/html-template`
- `remix/interaction`
- `remix/lazy-file`
- `remix/logger-middleware`
- `remix/method-override-middleware`
- `remix/mime`
- `remix/multipart-parser`
- `remix/node-fetch-server`
- `remix/response`
- `remix/route-pattern`
- `remix/session`
- `remix/session-middleware`
- `remix/session-storage-memcache`
- `remix/session-storage-redis`
- `remix/static-middleware`
- `remix/tar-parser`

Plus adapter/data helper subpaths and utility subpaths:

- `remix/data-schema/checks`, `remix/data-schema/coerce`,
  `remix/data-schema/lazy`
- `remix/data-table-mysql`, `remix/data-table-postgres`,
  `remix/data-table-sqlite`
- `remix/fetch-router/routes`
- `remix/component/jsx-runtime`, `remix/component/jsx-dev-runtime`,
  `remix/component/server`
- `remix/interaction/form`, `remix/interaction/keys`,
  `remix/interaction/popover`, `remix/interaction/press`
- `remix/response/compress`, `remix/response/file`, `remix/response/html`,
  `remix/response/redirect`
- `remix/route-pattern/specificity`
- `remix/session/cookie-storage`, `remix/session/fs-storage`,
  `remix/session/memory-storage`
- `remix/file-storage/fs`, `remix/file-storage/memory`
- `remix/multipart-parser/node`

## Navigation

- [Remix package index](./index.md)
