---
name: file-friction
description: >
  File durable repo or package papercuts through the friction-log package. Use
  when a session hits leftover friction outside the ship-pr pass. Ship-pr
  already files leftovers with friction-log/file before Discord.
---

# File friction

Policy (when to file, ownership, how to judge fixes):
[docs/contributing/friction-log.md](../../../docs/contributing/friction-log.md).

**File** durable, recurring pain with a clear owner and a reproducible contract
gap. **Skip** one-off agent confusion, session-only nits, and noise that will
not help the next agent.

**Where:** platform / this GitHub repo → `friction-log` on `kentcdodds/kody`
(never raw `gh`). A Kody package → package ownership (Patch); when the live
export supports a target host of `kody` (or equivalent), use that. Name the
target repository when the package supports it. Follow the live
`kody:@kentcdodds/friction-log` create/file contracts; do not invent fields.

File leftovers with `kody:@kentcdodds/friction-log/file` via Kody MCP `execute`
(`items`, one papercut each). Omit secrets. If there is nothing that meets the
bar, skip the call. A single issue can use
`kody:@kentcdodds/friction-log/create` (same doc; prefer qualify-before-create
when the package documents it).

```javascript
import fileFriction from 'kody:@kentcdodds/friction-log/file'

export default async function main() {
	return fileFriction({
		items: [
			{
				title: 'what hurt',
				whatHappened: '...',
				whatYouWanted: '...',
				howToReproduce: '...',
				cost: '...',
			},
		],
	})
}
```
