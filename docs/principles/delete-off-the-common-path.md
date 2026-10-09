# Delete what is off the common path

The common path is the one the product takes. Delete branches, fields, shims,
flags, and docs that exist only for a path the product does not take. A leftover
trains the next change to preserve it.

## Example

Workflows are created at runtime with `workflows.create`. Parse rejects a
manifest field for the same idea:

```ts
'kody.workflows is not a supported field; use workflows.create({ packageId, exportName }) from any runtime context.',
```

When a leftover needs a second deploy before it can go, open a GitHub issue in
the same change. See
[Cleanup after migrations](../contributing/cleanup-after-migrations.md).
