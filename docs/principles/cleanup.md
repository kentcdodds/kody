# Cleanup

When a new way replaces an old one, the migration is not done until the old way
is gone. Do not run two lanes forever. Hunt for leftovers and delete them:
compat shims, aliases, deprecation tracking, codemods with nothing left to
migrate, docs guards that still police the old name, and doc sentences that only
exist to say the old name is gone.

One-way doors (data drops, auth changes, token purges) still follow
[Two-way and one-way doors](./two-way-doors.md) and need Kent.

## Example

Publish rejects a configured package-app runtime mode so that field cannot come
back:

```ts
const retiredPackageAppRuntimeMessage =
	'kody.app.runtime was removed; every package app is a fetch handler and receives the mount-stripped path. There is no configured runtime mode.'
```

(`packages/worker/src/package-registry/manifest.ts`.) Stored stamps with
`remixVersion` fail closed in `isUsableStoredPublishedBundleArtifact`.

## Related

- [Delete what is off the common path](./delete-off-the-common-path.md)
- [Cleanup after migrations](../contributing/cleanup-after-migrations.md)
