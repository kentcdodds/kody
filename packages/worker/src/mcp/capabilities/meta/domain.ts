import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { metaMemoryDeleteCapability } from './meta-memory-delete.ts'
import { metaMemoryGetCapability } from './meta-memory-get.ts'
import { metaMemorySearchCapability } from './meta-memory-search.ts'
import { metaMemoryUpsertCapability } from './meta-memory-upsert.ts'
import { metaMemoryVerifyCapability } from './meta-memory-verify.ts'
import { metaGetHomeConnectorStatusCapability } from './meta-get-home-connector-status.ts'
import { metaListRemoteConnectorStatusCapability } from './meta-list-remote-connector-status.ts'
import { metaGetMcpServerInstructionsCapability } from './meta-get-mcp-server-instructions.ts'
import {
	metaAgentChatTurnCapability,
	metaAgentTurnCancelCapability,
	metaAgentTurnNextCapability,
	metaAgentTurnStartCapability,
} from './meta-agent-turn.ts'
import { metaListCapabilitiesCapability } from './meta-list-capabilities.ts'
import { metaRunSkillCapability } from './meta-run-skill.ts'
import { metaSetMcpServerInstructionsCapability } from './meta-set-mcp-server-instructions.ts'

export const metaDomain = defineDomain({
	name: capabilityDomainNames.meta,
	description:
		'Read or update per-user MCP server instruction overlays; verify, search, fetch, upsert, and delete long-term user memories; inspect the current runtime capability registry when search results seem incomplete.',
	keywords: [
		'meta',
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
		metaListRemoteConnectorStatusCapability,
		metaMemorySearchCapability,
		metaMemoryGetCapability,
		metaMemoryVerifyCapability,
		metaMemoryUpsertCapability,
		metaMemoryDeleteCapability,
		metaAgentChatTurnCapability,
		metaAgentTurnStartCapability,
		metaAgentTurnNextCapability,
		metaAgentTurnCancelCapability,
		metaRunSkillCapability,
	],
})
