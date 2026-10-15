import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { walkthroughHostCatalog } from '#universal/walkthrough-hosts.ts'
import {
	findWithAgentByPathname,
	pickWithAgentOrder,
	resolveWithAgentOrder,
	withAgentIconSrc,
	withAgents,
} from './with-agents.ts'

test('every agent with a /with page has an icon, steps, and a walkthrough host', () => {
	const slugs = withAgents.map((agent) => agent.slug)
	expect(new Set(slugs).size).toBe(slugs.length)
	expect([...slugs].sort()).toEqual(
		walkthroughHostCatalog.map((host) => host.id).sort(),
	)
	for (const agent of withAgents) {
		const icon = fileURLToPath(
			new URL(`../public${withAgentIconSrc(agent)}`, import.meta.url),
		)
		expect(existsSync(icon), icon).toBe(true)
		expect(agent.steps.length).toBeGreaterThan(0)
		expect(agent.pitch).not.toContain('\u2014')
	}
})

test('marquee order is a permutation and untrusted loader data is repaired', () => {
	const order = pickWithAgentOrder()
	expect([...order].sort()).toEqual(withAgents.map((a) => a.slug).sort())

	const repaired = resolveWithAgentOrder(['codex', 'nope', 'codex', 'cursor'])
	expect(repaired.slice(0, 2).map((agent) => agent.slug)).toEqual([
		'codex',
		'cursor',
	])
	expect(repaired).toHaveLength(withAgents.length)
	expect(resolveWithAgentOrder(undefined)).toHaveLength(withAgents.length)
})

test('pathname lookup only accepts /with/:agent for catalog agents', () => {
	expect(findWithAgentByPathname('/with/cursor')?.name).toBe('Cursor')
	expect(findWithAgentByPathname('/with/cursor/')?.name).toBe('Cursor')
	expect(findWithAgentByPathname('/with/unknown')).toBeNull()
	expect(findWithAgentByPathname('/with/cursor/extra')).toBeNull()
})
