---
name: file-friction
description: >
  File kentcdodds/kody repo papercuts through the friction-log package. Use when
  a session hits leftover repo friction outside the ship-pr pass. Ship-pr
  already files leftovers with friction-log/file before Discord.
---

# File friction

Policy:
[docs/contributing/friction-log.md](../../../docs/contributing/friction-log.md).

File leftovers with `kody:@kentcdodds/friction-log/file` via Kody MCP `execute`
(`items`, one papercut each). Omit secrets. If there is nothing to file, skip
the call. Do not use `gh issue create` or a raw GitHub issue POST. A single
issue can use `kody:@kentcdodds/friction-log/create` (same doc).

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
