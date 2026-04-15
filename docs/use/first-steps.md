# First steps

Kody exposes **search**, **execute**, and **open generated UI** as the main
tools. The agent should **search first** to find the right capability, skill, or
app name, then run work through **execute** (or **meta_run_skill** for a saved
skill).

## Habits that help

- **Reuse returned `conversationId` values.** If a prior tool response included
  one, pass it back unchanged on follow-up calls. Otherwise omit the field and
  use the server-generated value the tool returns. Do not make one up locally.
- **Pass `memoryContext`** when durable user memory may matter. Kody uses it to
  surface a small set of relevant long-term memories that have not already been
  shown in the same conversation.
- **Ask for natural-language goals**, for example: “Search Kody for GitHub pull
  request automation” or “Find Cloudflare DNS helpers.”
- **Do not paste secrets in chat.** Use saved secrets, generated UI, or the
  flows described in
  [Secrets, values, and host approval](./secrets-and-values.md).
- **Confirm destructive work** before mutating GitHub, Cloudflare, or Cursor
  Cloud Agents. See [Mutating actions and confirmations](./mutating-actions.md).
- **Verify before changing memory.** If you think something should become
  durable memory, call `meta_memory_verify` first, review related memories, and
  only then choose `meta_memory_upsert` or `meta_memory_delete`.

## Where to go next

- [Search](./search.md) — discovery, ranked results, and `entity` lookups
- [Execute and workflows](./execute.md) — chaining capability calls in one run
- [Memory and conversation context](./memory.md) — surfaced memories and the
  verify-first write workflow
- [Troubleshooting](./troubleshooting.md) — empty results, auth, and approvals
