# No breaking changes

We do not break people and their packages. If we ever need to make a breaking
change, we do it through a phased migration with a codemod, so users don't even
need to know what's going on. If a codemod isn't possible, we run a phased
migration and send a manual email explaining the change, including prompts users
can hand their agents to do the migration (or manual instructions if needed).
Then we give them time to migrate, proportional to how long, how complicated,
and how impactful the migration is.

## Related

- [Two-way and one-way doors](./two-way-doors.md): when a public contract is a
  one-way door
- [Cleanup](./cleanup.md): finish the migration by deleting the old lane
- [Cleanup after migrations](../contributing/cleanup-after-migrations.md)
