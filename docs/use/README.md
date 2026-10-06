# Usage reference

Served catalog: [`docs/guides`](../guides/README.md).

```bash
curl -fsS https://kody.codes/docs/search-and-execute.md
```

`search({ entity: "guide:search_and_execute" })`.

Files here are the MCP field reference those guides link to. Fetch one file:

```bash
curl -fsS https://raw.githubusercontent.com/kentcdodds/kody/main/docs/use/search.md
```

A file that only repeats a guide is a stub.
[what-can-kody-do.md](./what-can-kody-do.md) points at `guide:what_is_kody`.
