import { expect, test } from 'bun:test'
import { searchUnified } from './unified-search.ts'
import { type CapabilitySpec } from '#mcp/capabilities/types.ts'
import { type McpSkillRow } from '#mcp/skills/mcp-skills-types.ts'

function createSkillRow(skillId: string): McpSkillRow {
	return {
		id: skillId,
		user_id: 'user-123',
		title: 'Cursor agents with open PRs',
		description: 'Fetch Cursor agents with open GitHub PRs.',
		keywords: JSON.stringify(['cursor', 'agents', 'github', 'pr']),
		code: 'async () => ({ ok: true })',
		search_text: 'cursor agents open pull requests',
		uses_capabilities: null,
		parameters: null,
		inferred_capabilities: JSON.stringify([]),
		inference_partial: 0,
		read_only: 1,
		idempotent: 1,
		destructive: 0,
		created_at: '2026-03-20T00:00:00.000Z',
		updated_at: '2026-03-20T00:00:00.000Z',
	}
}

test('skill search hits include usage hints', async () => {
	const env = { SENTRY_ENVIRONMENT: 'test' } as Env
	const skillRow = createSkillRow('skill-usage-hint')
	const specs = {} as Record<string, CapabilitySpec>

	const result = await searchUnified({
		env,
		query: 'open pull requests for cursor agents',
		limit: 5,
		detail: false,
		specs,
		userId: 'user-123',
		skillRows: [skillRow],
		uiArtifactRows: [],
	})

	const skill = result.matches.find((match) => match.type === 'skill')
	if (!skill || skill.type !== 'skill') {
		throw new Error('Expected a skill match in results.')
	}

	expect(skill.usage).toContain('meta_run_skill')
	expect(skill.usage).toContain(skillRow.id)
	expect(skill.usage).toContain('"params"')
})

test('skill detail hits include usage hints', async () => {
	const env = { SENTRY_ENVIRONMENT: 'test' } as Env
	const skillRow = createSkillRow('skill-usage-detail')
	const specs = {} as Record<string, CapabilitySpec>

	const result = await searchUnified({
		env,
		query: 'cursor agents with open prs',
		limit: 5,
		detail: true,
		specs,
		userId: 'user-123',
		skillRows: [skillRow],
		uiArtifactRows: [],
	})

	const skill = result.matches.find((match) => match.type === 'skill')
	if (!skill || skill.type !== 'skill') {
		throw new Error('Expected a skill match in results.')
	}

	expect(skill.usage).toContain('meta_get_skill')
	expect(skill.usage).toContain(skillRow.id)
	expect(skill.usage).toContain('"params"')
})
