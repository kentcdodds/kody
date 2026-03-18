# data-table-mysql

Source: https://github.com/remix-run/remix/tree/main/packages/data-table-mysql

## README

MySQL adapter for `remix/data-table`.

## Installation

```sh
npm i remix mysql2
```

## Usage

```ts
import { createPool } from 'mysql2/promise'
import { createDatabase } from 'remix/data-table'
import { createMysqlDatabaseAdapter } from 'remix/data-table-mysql'

let pool = createPool(process.env.DATABASE_URL as string)
let db = createDatabase(createMysqlDatabaseAdapter(pool))
```

## Default capabilities

- `returning: false`
- `savepoints: true`
- `upsert: true`

MySQL has no native SQL `RETURNING`; write operations should use write metadata
(`affectedRows`, `insertId`) instead of returned row sets.

## Related packages

- [`data-table`](https://github.com/remix-run/remix/tree/main/packages/data-table)
- [`data-table-postgres`](https://github.com/remix-run/remix/tree/main/packages/data-table-postgres)
- [`data-table-sqlite`](https://github.com/remix-run/remix/tree/main/packages/data-table-sqlite)

## License

See [LICENSE](https://github.com/remix-run/remix/blob/main/LICENSE)

## Navigation

- [Remix package index](./index.md)
