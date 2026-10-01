import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	resolveCallerFeatureFlags,
	type CallerFeatureFlags,
} from '#mcp/capabilities/access-control.ts'
import { type ApiTokenRecord } from '#worker/api-tokens/service.ts'

/**
 * Who is calling the Open API. `token` is an HTTP request authenticated by a
 * scoped API token; `mcp` is the MCP `api` tool, which already holds the
 * user's full MCP grant, so scope checks do not apply to it.
 */
export type ApiPrincipal =
	| { kind: 'token'; token: ApiTokenRecord }
	| { kind: 'mcp' }

export type ApiInvocationContext = {
	env: Env
	callerContext: McpCallerContext & {
		user: NonNullable<McpCallerContext['user']>
	}
	principal: ApiPrincipal
	waitUntil?: (promise: Promise<unknown>) => void
	/** Memoized per invocation; resolves on first flag-gated check. */
	getFeatureFlags: () => Promise<CallerFeatureFlags>
}

export function createApiInvocationContext(input: {
	env: Env
	callerContext: ApiInvocationContext['callerContext']
	principal: ApiPrincipal
	waitUntil?: (promise: Promise<unknown>) => void
}): ApiInvocationContext {
	let featureFlags: Promise<CallerFeatureFlags> | null = null
	return {
		...input,
		getFeatureFlags() {
			featureFlags ??= resolveCallerFeatureFlags(input.env, input.callerContext)
			return featureFlags
		},
	}
}
