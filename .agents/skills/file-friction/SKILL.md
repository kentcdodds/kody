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

File leftovers with `kody:@kentcdodds/friction-log/file` via prefer-local CLI
execute when available
([prefer-local-cli-execute](../prefer-local-cli-execute/SKILL.md)). If `--local`
cannot run, fix the environment so local works — Open API / MCP `api` cannot
invoke this package export, and hosted MCP `execute` is banned. Pass `target` +
`items`, one papercut each. Include `whatHappened`, `whatYouWanted`,
`howToReproduce`, `cost`, and a short `preliminaryInvestigation` (what was
already looked at). Pass `relevantFiles` only when paths look relevant; omit
when none are known. Do not invent a root cause. Do not paste a full issue
thread. Omit secrets. If there is nothing that meets the bar, skip the call. A
single issue can use `kody:@kentcdodds/friction-log/create` (same `target`
contract).

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
				preliminaryInvestigation: 'what was already looked at',
				relevantFiles: ['path/when/known.ts'],
			},
		],
	})
}
```
