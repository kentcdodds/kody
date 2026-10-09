import { type z } from 'zod'
import { type ApiInvocationContext, type ApiPrincipal } from './context.ts'
import { invalidRequest } from './errors.ts'

export type NativeApiOperationDefinition = {
	summary: string
	description: string
	inputSchema: z.ZodType
	outputSchema: z.ZodType
	readOnly: boolean
	handler: (params: unknown, ctx: ApiInvocationContext) => Promise<unknown>
	/** `api_call` entity id; defaults to the operationId. */
	usageEntityId?: (params: unknown) => string
}

export type LocalExecuteHttpPrincipal = Extract<
	ApiPrincipal,
	{ kind: 'token' } | { kind: 'mcp-oauth' }
>

export function parseNativeInput<T extends z.ZodType>(
	schema: T,
	params: unknown,
) {
	const parsed = schema.safeParse(params ?? {})
	if (!parsed.success) {
		throw invalidRequest('Invalid parameters.', {
			issues: parsed.error.issues.map((issue) => ({
				path: issue.path.join('.'),
				message: issue.message,
			})),
		})
	}
	return parsed.data as z.infer<T>
}

export function requireTokenPrincipal(ctx: ApiInvocationContext) {
	if (ctx.principal.kind !== 'token') {
		throw invalidRequest(
			'This operation acts on the calling API token, so it is only available over HTTP with Authorization: Bearer kody_at_….',
		)
	}
	return ctx.principal.token
}

/**
 * CapabilityProxy and package-graph accept either a scoped `kody_at_` token
 * or CLI MCP OAuth (`mcp-oauth`). The MCP `api` tool principal is not used
 * on these HTTP routes.
 */
export function requireLocalExecuteHttpPrincipal(
	ctx: ApiInvocationContext,
): LocalExecuteHttpPrincipal {
	if (ctx.principal.kind === 'token' || ctx.principal.kind === 'mcp-oauth') {
		return ctx.principal
	}
	throw invalidRequest(
		'Local execute HTTP routes require Authorization: Bearer with a kody_at_ API token or a kody login OAuth access token.',
	)
}
