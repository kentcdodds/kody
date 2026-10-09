import { parseSafe } from 'remix/data-schema'
import {
	personalOrgId,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	mcpCallerContextSchema,
	type McpCallerContext,
	type McpCallerContextWire,
	type McpExecutionOrigin,
	type McpRepoContext,
	type McpStorageContext,
	type McpUserContext,
} from '@kody-internal/shared/chat.ts'

export type McpServerProps = McpCallerContext

export function createMcpCallerContext(input: {
	baseUrl: string
	executionOrigin?: McpExecutionOrigin
	user?: McpUserContext | null
	storageContext?: McpStorageContext | null
	repoContext?: McpRepoContext | null
	connectionProfileName?: string | null
}): McpCallerContext {
	const user = input.user ?? null
	const actor = user ? user.userId : null
	return {
		baseUrl: input.baseUrl,
		executionOrigin: input.executionOrigin,
		user,
		storageContext: input.storageContext ?? null,
		repoContext: input.repoContext ?? null,
		connectionProfileName: input.connectionProfileName ?? null,
		actor,
		owner: actor ? personalOrgId(actor) : null,
	}
}

/** Validate a serialized caller context and derive its actor and owner. */
export function parseMcpCallerContext(value: unknown): McpCallerContext {
	const result = parseSafe(mcpCallerContextSchema, value)
	if (!result.success) {
		const message = result.issues.map((issue) => issue.message).join(', ')
		throw new Error(`Invalid MCP caller context: ${message}`)
	}
	const { user, ...rest } = result.value
	return createMcpCallerContext({
		...rest,
		user: user ? { ...user, userId: personIdFromStored(user.userId) } : null,
	})
}

/** The serializable form of a caller context, without derived identities. */
export function toMcpCallerContextWire(
	context: McpCallerContext,
): McpCallerContextWire {
	const { actor: _actor, owner: _owner, ...wire } = context
	return wire
}
