# Two-way and one-way doors

A two-way door is cheap to reverse. Ship it and change it if it is wrong. A
one-way door is expensive to undo: a stored shape other packages already
published, a public contract, or deleted user data. Spend the review there.

Record the no in [decision records](../contributing/decisions/index.md) when the
next agent would otherwise re-propose it. Skip a record for a two-way tweak.

## Example

A stamp that published bundle artifacts already store is one-way. Readers reject
those payloads:

```ts
if (typeof artifact.remixVersion === 'string') return false
```

(`isUsableStoredPublishedBundleArtifact` in
`packages/worker/src/package-runtime/published-runtime-artifacts.ts`.) Guide
copy is two-way. Edit the page.
