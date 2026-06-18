import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { metaMemoryDeleteCapability } from './meta-memory-delete.ts'
import { metaMemoryGetCapability } from './meta-memory-get.ts'
import { metaMemorySearchCapability } from './meta-memory-search.ts'
import { metaMemoryUpsertCapability } from './meta-memory-upsert.ts'
import { metaMemoryVerifyCapability } from './meta-memory-verify.ts'
import { metaGetCurrentUserCapability } from './meta-get-current-user.ts'
import { metaListRemoteConnectorStatusCapability } from './meta-list-remote-connector-status.ts'
import { metaGetMcpServerInstructionsCapability } from './meta-get-mcp-server-instructions.ts'
import { executeCapability } from './execute.ts'
import { metaListCapabilitiesCapability } from './meta-list-capabilities.ts'
import { metaSetMcpServerInstructionsCapability } from './meta-set-mcp-server-instructions.ts'
import { searchCapability } from './search.ts'

export const metaDomain = defineDomain({
	name: capabilityDomainNames.meta,
	description:
		'Inspect the current runtime capability registry, read or update per-user MCP server instruction overlays, run package-first search/execute workflows, and manage long-term memories. Memory writes and deletes require a verify-first workflow: inspect related memories with meta_memory_verify before changing stored memory.',
	keywords: ['meta', 'codemode', 'capabilities', 'memory', 'verify'],
	capabilities: [
		searchCapability,
		executeCapability,
		metaListCapabilitiesCapability,
		metaGetCurrentUserCapability,
		metaGetMcpServerInstructionsCapability,
		metaSetMcpServerInstructionsCapability,
		metaListRemoteConnectorStatusCapability,
		metaMemorySearchCapability,
		metaMemoryGetCapability,
		metaMemoryVerifyCapability,
		metaMemoryUpsertCapability,
		metaMemoryDeleteCapability,
	],
})
