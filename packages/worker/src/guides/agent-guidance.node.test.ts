import { expect, test } from 'vitest'
import { getGuideById, getGuideBySlug } from '#worker/guides/catalog.ts'
import { docsNav } from '#universal/docs-nav.ts'
import {
	conventionInstructions,
	quickStartInstructions,
} from '#mcp/instructions/base-server-fragments.ts'
import { metaGetMcpServerInstructionsCapability } from '#mcp/capabilities/meta/meta-get-mcp-server-instructions.ts'
import { metaSetMcpServerInstructionsCapability } from '#mcp/capabilities/meta/meta-set-mcp-server-instructions.ts'
import { metaMemoryUpsertCapability } from '#mcp/capabilities/meta/meta-memory-upsert.ts'
import { metaMemoryVerifyCapability } from '#mcp/capabilities/meta/meta-memory-verify.ts'

test('agent_guidance is cataloged after Shared memory and linked from writers', () => {
	const guide = getGuideById('agent_guidance')
	expect(guide).toMatchObject({
		slug: 'agent-guidance',
		title: 'Where agent guidance lives',
		category: 'platform',
	})
	expect(getGuideBySlug('agent-guidance')?.id).toBe('agent_guidance')

	const concepts = docsNav.find((section) => section.id === 'concepts')
	expect(concepts).toBeTruthy()
	const index = concepts!.items.findIndex(
		(item) => item.slug === 'agent-guidance',
	)
	expect(concepts!.items[index - 1]?.slug).toBe('memory')
	expect(concepts!.items[index]?.label).toBe('Agent guidance')

	expect(quickStartInstructions).toContain('agent_guidance')
	expect(conventionInstructions).toContain('guide:agent_guidance')

	for (const capability of [
		metaGetMcpServerInstructionsCapability,
		metaSetMcpServerInstructionsCapability,
		metaMemoryUpsertCapability,
		metaMemoryVerifyCapability,
	]) {
		expect(capability.description).toContain('guide:agent_guidance')
	}
})
