import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { defaultKodyMcpUrl } from '#universal/onboarding-mcp-clients.ts'
import { walkthroughHostCatalog } from '#universal/walkthrough-hosts.ts'
import {
	findWithAgentByPathname,
	pickWithAgentOrder,
	resolveWithAgentOrder,
	withAgentIconSrc,
	withAgents,
	type WithAgent,
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

test('agents without an official path get the setup prompt and MCP URL', () => {
	const generic: ReadonlyArray<WithAgent> = withAgents.filter(
		(agent) => !agent.official,
	)
	expect(generic.map((agent) => agent.slug).sort()).toEqual(
		[
			'amp',
			'cue',
			'dots',
			'goose',
			'openmuse',
			'pi',
			'wajo',
			'warp',
			'zed',
		].sort(),
	)
	for (const agent of generic) {
		expect(agent.steps.filter((step) => 'prompt' in step)).toHaveLength(1)
		expect(agent.steps.some((step) => step.code === defaultKodyMcpUrl)).toBe(
			true,
		)
	}
	// OpenMuse needs its harness wired first; a chat prompt cannot add Kody.
	const openMuse = generic.find((agent) => agent.slug === 'openmuse')
	expect(openMuse?.steps[0]?.link?.href).toBe('/docs/openmuse')
	expect(openMuse?.steps.at(-1)).toMatchObject({ prompt: true })
	for (const agent of withAgents.filter((agent) => agent.official)) {
		expect(agent.steps.some((step) => 'prompt' in step)).toBe(false)
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
