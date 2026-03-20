# Remix packages

Docs for every package in https://github.com/remix-run/remix/tree/main/packages.

## Table of contents

- [Start here](#start-here)
- [UI and components](#ui-and-components)
- [Routing and requests](#routing-and-requests)
- [Data and SQL](#data-and-sql)
- [Sessions and cookies](#sessions-and-cookies)
- [Responses and headers](#responses-and-headers)
- [Uploads and parsing](#uploads-and-parsing)
- [Files and storage](#files-and-storage)
- [Middleware and utilities](#middleware-and-utilities)
- [Package map](#package-map)
- [Update instructions](#update-instructions)

## Start here

- Building UI with Remix Component: [component](./component/index.md)
- Routing and request handling: [fetch-router](./fetch-router/index.md) +
  [route-pattern](./route-pattern.md)
- Sessions and cookies: [session](./session/index.md) +
  [session-middleware](./session-middleware.md) + [cookie](./cookie.md)
- Responses, headers, and HTML safety: [response](./response/index.md) +
  [headers](./headers/index.md) + [html-template](./html-template.md)
- Data validation and SQL tables: [data-schema](./data-schema.md) +
  [data-table](./data-table.md)
- File upload pipelines: [form-data-middleware](./form-data-middleware.md) +
  [form-data-parser](./form-data-parser.md) +
  [multipart-parser](./multipart-parser/index.md)
- File storage and streaming: [file-storage](./file-storage.md) +
  [file-storage-s3](./file-storage-s3.md) + [lazy-file](./lazy-file.md) +
  [fs](./fs.md)
- Static assets and compression: [static-middleware](./static-middleware.md) +
  [compression-middleware](./compression-middleware/index.md)

## kody adoption snapshot

- Primary runtime packages in active use:
  - `remix/component`
  - `remix/fetch-router`
  - `remix/data-schema`
  - `remix/data-table`
- D1 integration uses `remix/data-table` with a repository adapter
  (`packages/worker/src/d1-data-table-adapter.ts`) instead of
  `remix/data-table-sqlite`.
- Package coverage audit against installed `remix@3.0.0-alpha.3` top-level
  exports: no missing Remix package docs in this index.

## UI and components

- [component](./component/index.md)
  - [Getting started](./component/getting-started.md)
  - [Components](./component/components.md)
  - [Styling basics](./component/styling-basics.md)
  - [Animate basics](./component/animate-basics.md)
  - [Testing](./component/testing.md)
- [interaction](./interaction/index.md)
  - [Event listeners and interactions](./interaction/listeners.md)
  - [Containers and disposal](./interaction/containers-and-disposal.md)
  - [Custom interactions and typed targets](./interaction/custom-interactions.md)

## Routing and requests

- [fetch-router](./fetch-router/index.md)
  - [Basic usage and route maps](./fetch-router/usage.md)
  - [Routing based on request method](./fetch-router/routing-methods.md)
  - [Resource-based routes](./fetch-router/routing-resources.md)
  - [Middleware and request context](./fetch-router/middleware.md)
- [route-pattern](./route-pattern.md)
- [node-fetch-server](./node-fetch-server/index.md)
  - [Quick start](./node-fetch-server/quick-start.md)
  - [Advanced usage](./node-fetch-server/advanced-usage.md)
  - [Migration from Express](./node-fetch-server/migration.md)
  - [Demos and benchmark](./node-fetch-server/demos-and-benchmark.md)
- [fetch-proxy](./fetch-proxy.md)

## Data and SQL

- [data-schema](./data-schema.md)
- [data-table](./data-table.md)
- [data-table-postgres](./data-table-postgres.md)
- [data-table-mysql](./data-table-mysql.md)
- [data-table-sqlite](./data-table-sqlite.md)

## Sessions and cookies

- [session](./session/index.md)
  - [Flash data and security](./session/flash-and-security.md)
  - [Storage strategies](./session/storage-strategies.md)
  - [Related packages](./session/related.md)
- [session-middleware](./session-middleware.md)
- [session-storage-memcache](./session-storage-memcache.md)
- [session-storage-redis](./session-storage-redis.md)
- [cookie](./cookie.md)

## Responses and headers

- [response](./response/index.md)
  - [File responses](./response/file-responses.md)
  - [HTML responses](./response/html-responses.md)
  - [Redirect responses](./response/redirect-responses.md)
  - [Compressed responses](./response/compress-responses.md)
  - [Related packages](./response/related.md)
- [headers](./headers/index.md)
  - [Accept headers](./headers/accept-headers.md)
  - [Content and cache headers](./headers/content-headers.md)
  - [Cookie headers](./headers/cookie-headers.md)
  - [Conditionals and ranges](./headers/conditional-headers.md)
  - [Raw header parsing](./headers/raw-headers.md)
- [html-template](./html-template.md)

## Uploads and parsing

- [form-data-middleware](./form-data-middleware.md)
- [form-data-parser](./form-data-parser.md)
- [multipart-parser](./multipart-parser/index.md)
  - [Limits and Node bindings](./multipart-parser/limits-and-node.md)
  - [Low-level APIs](./multipart-parser/low-level.md)
  - [Benchmarks and related packages](./multipart-parser/benchmarks.md)

## Files and storage

- [file-storage](./file-storage.md)
- [file-storage-s3](./file-storage-s3.md)
- [lazy-file](./lazy-file.md)
- [fs](./fs.md)
- [tar-parser](./tar-parser.md)

## Middleware and utilities

- [compression-middleware](./compression-middleware/index.md)
  - [Options and configuration](./compression-middleware/options.md)
- [static-middleware](./static-middleware.md)
- [logger-middleware](./logger-middleware.md)
- [method-override-middleware](./method-override-middleware.md)
- [async-context-middleware](./async-context-middleware.md)
- [mime](./mime.md)
- [remix](./remix.md)

## Package map

| Package                    | Focus                                      | Docs                                                          |
| -------------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| async-context-middleware   | AsyncLocalStorage context for fetch-router | [async-context-middleware](./async-context-middleware.md)     |
| component                  | Remix Component UI system                  | [component](./component/index.md)                             |
| compression-middleware     | Response compression for fetch-router      | [compression-middleware](./compression-middleware/index.md)   |
| cookie                     | Cookie parsing, signing, and serialization | [cookie](./cookie.md)                                         |
| data-schema                | Runtime validation and schema parsing      | [data-schema](./data-schema.md)                               |
| data-table                 | Typed SQL query toolkit                    | [data-table](./data-table.md)                                 |
| data-table-mysql           | MySQL adapter for data-table               | [data-table-mysql](./data-table-mysql.md)                     |
| data-table-postgres        | Postgres adapter for data-table            | [data-table-postgres](./data-table-postgres.md)               |
| data-table-sqlite          | SQLite adapter for data-table              | [data-table-sqlite](./data-table-sqlite.md)                   |
| fetch-proxy                | Fetch-based HTTP proxy                     | [fetch-proxy](./fetch-proxy.md)                               |
| fetch-router               | Fetch-based router and middleware          | [fetch-router](./fetch-router/index.md)                       |
| file-storage               | Storage abstraction for files              | [file-storage](./file-storage.md)                             |
| file-storage-s3            | S3 backend for file-storage                | [file-storage-s3](./file-storage-s3.md)                       |
| form-data-middleware       | Request FormData middleware                | [form-data-middleware](./form-data-middleware.md)             |
| form-data-parser           | Streaming multipart/form-data parser       | [form-data-parser](./form-data-parser.md)                     |
| fs                         | Lazy file system utilities                 | [fs](./fs.md)                                                 |
| headers                    | Header parsing and helpers                 | [headers](./headers/index.md)                                 |
| html-template              | Safe HTML template tag                     | [html-template](./html-template.md)                           |
| interaction                | Event helpers and interactions             | [interaction](./interaction/index.md)                         |
| lazy-file                  | Streaming File/Blob implementation         | [lazy-file](./lazy-file.md)                                   |
| logger-middleware          | Request/response logging                   | [logger-middleware](./logger-middleware.md)                   |
| method-override-middleware | HTML form method override                  | [method-override-middleware](./method-override-middleware.md) |
| mime                       | MIME type utilities                        | [mime](./mime.md)                                             |
| multipart-parser           | Streaming multipart parser                 | [multipart-parser](./multipart-parser/index.md)               |
| node-fetch-server          | Fetch-based Node server                    | [node-fetch-server](./node-fetch-server/index.md)             |
| remix                      | Remix framework package                    | [remix](./remix.md)                                           |
| response                   | Response helpers                           | [response](./response/index.md)                               |
| route-pattern              | URL matching and href generation           | [route-pattern](./route-pattern.md)                           |
| session                    | Session management and storage             | [session](./session/index.md)                                 |
| session-middleware         | Session middleware for fetch-router        | [session-middleware](./session-middleware.md)                 |
| session-storage-memcache   | Memcache storage adapter for sessions      | [session-storage-memcache](./session-storage-memcache.md)     |
| session-storage-redis      | Redis storage adapter for sessions         | [session-storage-redis](./session-storage-redis.md)           |
| static-middleware          | Static file middleware                     | [static-middleware](./static-middleware.md)                   |
| tar-parser                 | Streaming tar parser                       | [tar-parser](./tar-parser.md)                                 |

## Update instructions

See [update](./update.md) for how to sync this documentation from upstream.
