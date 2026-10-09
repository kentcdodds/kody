import { parseSafe } from 'remix/data-schema'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import {
	mcpCallerContextSchema,
	type McpCallerContext,
	type McpCallerContextWire,
	type McpExecutionOrigin,
	type McpRepoContext,
	type McpStorageContext,
	type McpUserContext,
} from '@kody-internal/shared/chat.ts'
import {
	deriveRequestContext,
	type RequestOrgBinding,
	type RequestSource,
} from '#worker/request-context/request-context.ts'

/** Legacy agent props persist in Durable Object storage, so they stay wire-shaped. */
export type McpServerProps = McpCallerContextWire

type McpCallerContextWireInput = {
	baseUrl: string
	executionOrigin?: McpExecutionOrigin
	user?: McpUserContext | null
	storageContext?: McpStorageContext | null
	repoContext?: McpRepoContext | null
	connectionProfileName?: string | null
}

/** The persisted form only (job `caller_context_json`); no request context. */
export function createMcpCallerContextWire(
	input: McpCallerContextWireInput,
): McpCallerContextWire {
	return {
		baseUrl: input.baseUrl,
		executionOrigin: input.executionOrigin,
		user: input.user ?? null,
		storageContext: input.storageContext ?? null,
		repoContext: input.repoContext ?? null,
		connectionProfileName: input.connectionProfileName ?? null,
	}
}

export function createMcpCallerContext(
	input: McpCallerContextWireInput & {
		/** How this request reached Kody; decides actor, attribution, credential. */
		source: RequestSource
		/**
		 * DB-backed org membership when available. MCP/API call sites that do
		 * not pass this still derive personalOrgId from the user.
		 */
		orgBinding?: RequestOrgBinding
		/** API-token scopes; null/omitted does not narrow the actor. */
		scopes?: ReadonlyArray<OrgPermission> | null
	},
): McpCallerContext {
	const wire = createMcpCallerContextWire(input)
	return {
		...wire,
		request: wire.user
			? deriveRequestContext({
					user: wire.user,
					source: input.source,
					profileName: wire.connectionProfileName,
					orgBinding: input.orgBinding,
					scopes: input.scopes ?? null,
				})
			: null,
	}
}

/** Validate a serialized caller context without deriving a request context. */
export function parseMcpCallerContextWire(
	value: unknown,
): McpCallerContextWire {
	const result = parseSafe(mcpCallerContextSchema, value)
	if (!result.success) {
		const message = result.issues.map((issue) => issue.message).join(', ')
		throw new Error(`Invalid MCP caller context: ${message}`)
	}
	const { user, ...rest } = result.value
	return createMcpCallerContextWire({
		...rest,
		user: user ? { ...user, userId: personIdFromStored(user.userId) } : null,
	})
}

/** Validate a serialized caller context and derive its request context. */
export function parseMcpCallerContext(
	value: unknown,
	source: RequestSource,
): McpCallerContext {
	return createMcpCallerContext({
		...parseMcpCallerContextWire(value),
		source,
	})
}

/** The serializable form of a caller context, without derived identities. */
export function toMcpCallerContextWire(
	context: McpCallerContext,
): McpCallerContextWire {
	const { request: _request, ...wire } = context
	return wire
}
