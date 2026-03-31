# First steps

Kody exposes **search**, **execute**, and **open generated UI** as the main
tools. The agent should **search first** to find the right capability, skill, or
app name, then run work through **execute** (or **meta_run_skill** for a saved
skill).

## Habits that help

- **Pass `conversationId` back** on follow-up calls when the tool response
  includes one. That keeps related calls grouped and can reduce response size.
- **Ask for natural-language goals**, for example: “Search Kody for GitHub pull
  request automation” or “Find Cloudflare DNS helpers.”
- **Do not paste secrets in chat.** Use saved secrets, generated UI, or the
  flows described in
  [Secrets, values, and host approval](./secrets-and-values.md).
- **Confirm destructive work** before mutating GitHub, Cloudflare, or Cursor
  Cloud Agents. See [Mutating actions and confirmations](./mutating-actions.md).

## Where to go next

- [Search](./search.md) — discovery, ranked results, and `entity` lookups
- [Execute and workflows](./execute.md) — chaining capability calls in one run
- [Troubleshooting](./troubleshooting.md) — empty results, auth, and approvals
