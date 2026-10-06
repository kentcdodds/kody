# Cleanup

When a new way replaces an old one, the migration is not done until the old way
is gone. Do not run two lanes forever. Hunt for leftovers and delete them:
compat shims, aliases, deprecation tracking, codemods with nothing left to
migrate, docs guards that still police the old name, and doc sentences that only
exist to say the old name is gone.

One-way doors (data drops, auth changes, token purges) still follow
[Two-way and one-way doors](./two-way-doors.md) and need Kent.

## Example

`packages.invoke` is gone as an author-facing API. The docs guard allows only
the present-tense negation, then fails any other mention:

```ts
export const allowedPackagesInvokePhrasePattern =
	/\bthere is no author-facing\s+(?:\\?`)?packages\.invoke(?:\\?`)?\b/i
```

(`tools/check-docs-no-packages-invoke.ts`,
`npm run docs:check-no-packages-invoke`.) Leftovers that still trip that check
(including oxfmt wrapping the allowed sentence,
[#2975](https://github.com/kentcdodds/kody/issues/2975)) are being removed by
[Remove packages.invoke completely](https://cursor.com/agents/bc-026e6a59-87a9-55f1-b70d-1b11df3f4ecb);
link that agent's PR here once it lands. Do not reopen a second removal track.

## Related

- [Delete what is off the common path](./delete-off-the-common-path.md)
- [Cleanup after migrations](../contributing/cleanup-after-migrations.md)
