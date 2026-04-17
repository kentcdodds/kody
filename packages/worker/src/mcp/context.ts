import { parseSafe } from 'remix/data-schema'
import {
	mcpCallerContextSchema,
	type McpCallerContext,
	type McpRepoContext,
	type McpStorageContext,
	type McpUserContext,
} from '@kody-internal/shared/chat.ts'
import { type RemoteConnectorRef } from '@kody-internal/shared/remote-connectors.ts'

export type McpServerProps = McpCallerContext

export function createMcpCallerContext(input: {
	baseUrl: string
	user?: McpUserContext | null
	homeConnectorId?: string | null
	remoteConnectors?: Array<RemoteConnectorRef> | null
	storageContext?: McpStorageContext | null
	repoContext?: McpRepoContext | null
}): McpCallerContext {
	return {
		baseUrl: input.baseUrl,
		user: input.user ?? null,
		homeConnectorId: input.homeConnectorId ?? null,
		remoteConnectors: input.remoteConnectors ?? null,
		storageContext: input.storageContext ?? null,
		repoContext: input.repoContext ?? null,
	}
}

export function parseMcpCallerContext(value: unknown): McpCallerContext {
	const result = parseSafe(mcpCallerContextSchema, value)
	if (!result.success) {
		const message = result.issues.map((issue) => issue.message).join(', ')
		throw new Error(`Invalid MCP caller context: ${message}`)
	}
	return result.value
}
