import { z } from 'zod'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	buildKodyToolContext,
	createWorkflowTools,
} from '#mcp/run-kody-registry.ts'
import {
	createExecutionSecretRedactor,
	type ExecutionSecretRedactor,
} from '#mcp/secrets/execution-secret-redactor.ts'
import { type ApiInvocationContext } from './context.ts'
import { ApiError, invalidRequest, notFound, toApiError } from './errors.ts'
import { maxApiRequestBodyBytes } from './request-params.ts'

/**
 * CapabilityProxy: the cloud half of local execute (`kody execute --local`,
 * `@kodycodes/cli`). The CLI runs modules in a local workerd and forwards every
 * `kody:runtime` call here as `{ path, args }`; this dispatches it through the
 * same `kody.*` tool map ad hoc cloud execute builds, so capabilities,
 * `kody.mcp`, and `workflows.create` behave as they do in the cloud. Static
 * `kody:@…` imports are downloaded via `POST /v1/local-execute/package-graph`
 * and embedded in that workerd — never a silent whole-module hop to
 * `kody.execute`. There is no author-facing `packages.invoke`. Local CPU is
 * never metered; each hop is one `api_call`, and the capability behind it
 * meters itself as usual.
 */

export const capabilityProxyLimits = {
	maxPathSegments: 8,
	maxPathSegmentLength: 200,
	maxArgs: 8,
	maxRequestBytes: maxApiRequestBodyBytes,
} as const

const pathSegmentSchema = z
	.string()
	.min(1)
	.max(capabilityProxyLimits.maxPathSegmentLength)

export const capabilityProxyCallInputSchema = z
	.object({
		path: z
			.array(pathSegmentSchema)
			.min(2)
			.max(capabilityProxyLimits.maxPathSegments)
			.describe(
				"`kody:runtime` property path, e.g. `['kody','emailSend']`, `['kody','mcp','home','lights_on']`, or `['workflows','create']`.",
			),
		args: z
			.array(z.unknown())
			.max(capabilityProxyLimits.maxArgs)
			.describe('Positional arguments passed to the runtime function.'),
		conversationId: z
			.string()
			.min(1)
			.max(64)
			.optional()
			.describe('Optional MCP conversation id to attribute the call to.'),
	})
	.strict()

export type CapabilityProxyCallInput = z.infer<
	typeof capabilityProxyCallInputSchema
>

export const capabilityProxyCallOutputSchema = z.object({
	result: z.unknown().describe('Return value of the runtime call (JSON).'),
})

export const capabilityProxySessionOutputSchema = z.object({
	scopes: z.array(z.string()),
	expiresAt: z
		.string()
		.describe('Sliding expiry; every proxied call pushes it forward.'),
	maxExpiresAt: z.string().describe('Absolute expiry of the token.'),
	idleTtlSeconds: z.number().int(),
	user: z.object({ userId: z.string(), email: z.string() }),
	limits: z.object({
		maxPathSegments: z.number().int(),
		maxArgs: z.number().int(),
		maxRequestBytes: z.number().int(),
	}),
})

export function capabilityProxyUsageEntityId(params: unknown) {
	const parsed = capabilityProxyCallInputSchema.safeParse(params)
	return parsed.success
		? `capability-proxy:${parsed.data.path.join('.')}`.slice(0, 200)
		: 'capability-proxy:invalid'
}

function describePath(path: ReadonlyArray<string>) {
	return path.join('.')
}

class CapabilityInvocationError extends Error {
	constructor(cause: unknown) {
		super('Capability invocation failed.', { cause })
		this.name = 'CapabilityInvocationError'
	}
}

async function invokeCapability<T>(invoke: () => Promise<T> | T) {
	try {
		return await invoke()
	} catch (error) {
		throw new CapabilityInvocationError(error)
	}
}

async function callKodyPath(input: {
	ctx: ApiInvocationContext
	path: ReadonlyArray<string>
	args: ReadonlyArray<unknown>
	redactor: ExecutionSecretRedactor
}) {
	const { ctx, path, args, redactor } = input
	const { tools, mcpServers } = await buildKodyToolContext(
		ctx.env,
		ctx.callerContext,
		{
			trackSecretInputValue: (value) => redactor.track(value),
			workflowTools: createWorkflowTools({
				env: ctx.env,
				callerContext: ctx.callerContext,
				packageContext: null,
			}),
			...(ctx.waitUntil ? { waitUntil: ctx.waitUntil } : {}),
		},
	)
	if (path[1] === 'mcp') {
		const [, , serverName, toolName] = path
		if (path.length !== 4 || !serverName || !toolName) {
			throw notFound(
				`kody.mcp calls must look like kody.mcp.<server>.<tool>(args); got ${describePath(path)}.`,
			)
		}
		const server = mcpServers.find((entry) => entry.name === serverName)
		if (!server) {
			throw notFound(
				`Unknown MCP server "${serverName}". Available MCP servers: ${
					mcpServers.map((entry) => entry.name).join(', ') || '(none)'
				}.`,
			)
		}
		if (!server.status.connected || server.status.toolCount === 0) {
			throw invalidRequest(server.status.unavailableMessage)
		}
		const capability = server.capabilities.find(
			(entry) => entry.name === toolName,
		)
		const tool = capability ? tools[capability.dispatchName] : undefined
		if (!tool) {
			throw notFound(
				`Unknown tool "${toolName}" for MCP server "${serverName}". Available tools: ${
					server.capabilities.map((entry) => entry.name).join(', ') || '(none)'
				}.`,
			)
		}
		return invokeCapability(() => tool(args[0]))
	}
	const [, name] = path
	const tool = name && Object.hasOwn(tools, name) ? tools[name] : undefined
	if (path.length !== 2 || !tool) {
		throw notFound(`Unknown runtime function kody.${path.slice(1).join('.')}.`)
	}
	return invokeCapability(() => tool(args[0]))
}

async function dispatchCapabilityProxyCall(input: {
	ctx: ApiInvocationContext
	call: CapabilityProxyCallInput
	redactor: ExecutionSecretRedactor
}) {
	const { ctx, call, redactor } = input
	const [root, name] = call.path
	if (root === 'kody') {
		return callKodyPath({ ctx, path: call.path, args: call.args, redactor })
	}
	if (root === 'workflows' && name === 'create' && call.path.length === 2) {
		const workflowTools = createWorkflowTools({
			env: ctx.env,
			callerContext: ctx.callerContext,
			packageContext: null,
		})
		return invokeCapability(() => workflowTools.create(call.args[0] as never))
	}
	if (root === 'packages' && name === 'invoke') {
		throw notFound(
			`There is no author-facing packages.invoke. Use a static kody:@scope/package/export import when the name is known, or import(specifier) when the name is data.`,
		)
	}
	throw notFound(
		`Unknown runtime path ${describePath(call.path)}. CapabilityProxy serves kody.*, kody.mcp.<server>.<tool>, and workflows.create.`,
	)
}

/**
 * Run one proxied `kody:runtime` call. Errors the capability throws reach
 * local user code with the message cloud execute would show, minus secret
 * values the call wrote and API tokens. Platform failures outside the
 * capability return the generic internal error and are logged here.
 */
export async function runCapabilityProxyCall(input: {
	ctx: ApiInvocationContext
	call: CapabilityProxyCallInput
}) {
	const redactor = createExecutionSecretRedactor()
	try {
		return {
			result:
				(await dispatchCapabilityProxyCall({ ...input, redactor })) ?? null,
		}
	} catch (error) {
		const fromCapability = error instanceof CapabilityInvocationError
		const cause = fromCapability ? error.cause : error
		const apiError = toApiError(cause)
		if (cause instanceof ApiError || apiError.status < 500) {
			throwRedacted(apiError, redactor)
		}
		if (fromCapability) {
			throw new ApiError({
				status: 500,
				code: 'capability_error',
				message: redactor.redactErrorMessage(getErrorMessage(cause)),
			})
		}
		console.error('capability-proxy platform failure', {
			path: describePath(input.call.path),
			userId: input.ctx.callerContext.user?.userId ?? null,
			error: redactor.redactErrorMessage(getErrorMessage(cause)),
		})
		throw apiError
	}
}

function throwRedacted(
	apiError: ApiError,
	redactor: ExecutionSecretRedactor,
): never {
	const message = redactor.redactErrorMessage(apiError.message)
	if (message === apiError.message) throw apiError
	throw new ApiError({
		status: apiError.status,
		code: apiError.code,
		message,
		details: redactor.redactUnknown(apiError.details),
		headers: apiError.headers,
	})
}
