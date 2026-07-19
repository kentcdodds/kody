import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { metaMemoryDeleteCapability } from './meta-memory-delete.ts'
import { metaMemoryGetCapability } from './meta-memory-get.ts'
import { metaMemorySearchCapability } from './meta-memory-search.ts'
import { metaMemoryUpsertCapability } from './meta-memory-upsert.ts'
import { metaMemoryVerifyCapability } from './meta-memory-verify.ts'
import { metaPlatformFeedbackSubmitCapability } from './meta-platform-feedback-submit.ts'
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
		'Runtime capability registry inspection, per-user MCP instruction overlays, package-first search/execute workflows, long-term memory management (verify-first: meta_memory_verify before writes or deletes), and consent-gated attributed platform feedback.',
	keywords: [
		'meta',
		'kody',
		'capabilities',
		'memory',
		'verify',
		'platform feedback',
		'friction',
		'bug report',
		'suggestion',
	],
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
		metaPlatformFeedbackSubmitCapability,
	],
})
