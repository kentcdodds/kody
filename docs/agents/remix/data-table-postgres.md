# data-table-postgres

Source:
https://github.com/remix-run/remix/tree/main/packages/data-table-postgres

## README

PostgreSQL adapter for `remix/data-table`.

## Installation

```sh
npm i remix pg
```

## Usage

```ts
import { Pool } from 'pg'
import { createDatabase } from 'remix/data-table'
import { createPostgresDatabaseAdapter } from 'remix/data-table-postgres'

let pool = new Pool({
	connectionString: process.env.DATABASE_URL,
})

let db = createDatabase(createPostgresDatabaseAdapter(pool))
```

## Default capabilities

- `returning: true`
- `savepoints: true`
- `upsert: true`

## Related packages

- [`data-table`](https://github.com/remix-run/remix/tree/main/packages/data-table)
- [`data-table-mysql`](https://github.com/remix-run/remix/tree/main/packages/data-table-mysql)
- [`data-table-sqlite`](https://github.com/remix-run/remix/tree/main/packages/data-table-sqlite)

## License

See [LICENSE](https://github.com/remix-run/remix/blob/main/LICENSE)

## Navigation

- [Remix package index](./index.md)
