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
not help the next agent. `create` / `file` soft-skip the same shapes.

**Where:** always pass required
`target: { host: 'github' | 'kody', repo: string }`.

- Platform / this repo → `{ host: 'github', repo: 'kentcdodds/kody' }` (never
  raw `gh`).
- Kody package → `{ host: 'kody', repo: '@owner/leaf' }` (wakes Patch; no GitHub
  issue).

File leftovers with `kody:@kentcdodds/friction-log/file` via Kody MCP `execute`
(`target` + `items`, one papercut each). Omit secrets. If there is nothing that
meets the bar, skip the call. A single issue can use
`kody:@kentcdodds/friction-log/create` (same `target` contract).

```javascript
import fileFriction from 'kody:@kentcdodds/friction-log/file'

export default async function main() {
	return fileFriction({
		target: { host: 'github', repo: 'kentcdodds/kody' },
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
