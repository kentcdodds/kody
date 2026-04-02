import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { metaDeleteSkillCapability } from './meta-delete-skill.ts'
import { metaMemoryDeleteCapability } from './meta-memory-delete.ts'
import { metaMemoryGetCapability } from './meta-memory-get.ts'
import { metaMemorySearchCapability } from './meta-memory-search.ts'
import { metaMemoryUpsertCapability } from './meta-memory-upsert.ts'
import { metaMemoryVerifyCapability } from './meta-memory-verify.ts'
import { metaGetHomeConnectorStatusCapability } from './meta-get-home-connector-status.ts'
import { metaGetMcpServerInstructionsCapability } from './meta-get-mcp-server-instructions.ts'
import { metaGetSkillCapability } from './meta-get-skill.ts'
import { metaListCapabilitiesCapability } from './meta-list-capabilities.ts'
import { metaListSkillCollectionsCapability } from './meta-list-skill-collections.ts'
import { metaRunSkillCapability } from './meta-run-skill.ts'
import { metaSaveSkillCapability } from './meta-save-skill.ts'
import { metaSetMcpServerInstructionsCapability } from './meta-set-mcp-server-instructions.ts'

export const metaDomain = defineDomain({
	name: capabilityDomainNames.meta,
	description:
		'Save, list via search, load, run, and delete user-scoped codemode skills; read or update per-user MCP server instruction overlays; verify, search, fetch, upsert, and delete long-term user memories. Skill saves upsert by unique name per user. Memory writes and deletes require a verify-first workflow: inspect related memories with meta_memory_verify before changing stored memory. Inspect the current runtime capability registry when search results seem incomplete. Save skills only for reasonably repeatable workflows (reusable patterns), not one-off or highly bespoke tasks.',
	keywords: [
		'skill',
		'meta',
		'save',
		'recipe',
		'codemode',
		'capabilities',
		'memory',
		'verify',
	],
	capabilities: [
		metaListCapabilitiesCapability,
		metaGetMcpServerInstructionsCapability,
		metaSetMcpServerInstructionsCapability,
		metaGetHomeConnectorStatusCapability,
		metaMemorySearchCapability,
		metaMemoryGetCapability,
		metaMemoryVerifyCapability,
		metaMemoryUpsertCapability,
		metaMemoryDeleteCapability,
		metaListSkillCollectionsCapability,
		metaSaveSkillCapability,
		metaDeleteSkillCapability,
		metaGetSkillCapability,
		metaRunSkillCapability,
	],
})
