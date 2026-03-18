# data-schema

Source: https://github.com/remix-run/remix/tree/main/packages/data-schema

## README

`data-schema` is a tiny, standards-aligned validation and parsing library used
across Remix packages.

- Compatible with [Standard Schema](https://standardschema.dev/) v1
- Runtime-agnostic (browser, Node.js, Bun, Deno, Workers)
- Designed for schema-first parsing with strong TypeScript inference

## Installation

```sh
npm i remix
```

## Package exports

- `remix/data-schema` - core schema builders and `parse`/`parseSafe`
- `remix/data-schema/checks` - reusable validation checks (`min`, `email`, etc.)
- `remix/data-schema/coerce` - coercion helpers for stringly input
- `remix/data-schema/lazy` - lazy schema support for recursive types

## Usage

```ts
import { object, parse, string } from 'remix/data-schema'
import { email, minLength } from 'remix/data-schema/checks'
import * as coerce from 'remix/data-schema/coerce'

let User = object({
	id: string(),
	email: string().pipe(email()),
	username: string().pipe(minLength(3)),
	age: coerce.number(),
})

let user = parse(User, {
	id: 'u1',
	email: 'ada@example.com',
	username: 'ada',
	age: '37',
})
```

Use `parseSafe` when you want structured validation results instead of thrown
errors.

## Related packages

- [`data-table`](https://github.com/remix-run/remix/tree/main/packages/data-table) -
  SQL toolkit that validates writes with `data-schema`
- [`form-data-parser`](https://github.com/remix-run/remix/tree/main/packages/form-data-parser) -
  common pair for parsing request input before schema validation

## License

See [LICENSE](https://github.com/remix-run/remix/blob/main/LICENSE)

## Navigation

- [Remix package index](./index.md)
