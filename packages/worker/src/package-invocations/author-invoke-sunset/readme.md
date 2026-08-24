# Author `packages.invoke` sunset

Quarantine for the `kody:runtime` `packages.invoke` helper (decision
[0037](../../../../../docs/contributing/decisions/0037-no-author-packages-invoke.md)).

**Do not add new author-facing call sites.** HTTP invocation tokens, jobs,
subscriptions, and apps use host `invokePackageExport` / `runSavedPackageModule`
in the parent folder. Those stay.

Tracker: [#1750](https://github.com/kentcdodds/kody/issues/1750).

Delete this leftover when:

1. Fleet codemod `0008-packages-invoke-to-static-import` has applied (or
   `needsManual` is empty enough).
2. Computed `import(specifier)` loads caller-owned modules.
3. Usage docs, guides, and MCP copy no longer mention `packages.invoke`.

The helper implementation still lives in `runtime-tool-factories.ts` and
`run-kody-registry.ts` until that cleanup. This folder exists so the leftover
has one named home to remove.
