import {
	resolveProvider,
	type ResolvedProvider,
	type ToolProvider,
} from '@cloudflare/codemode'
import { exports as workerExports } from 'cloudflare:workers'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { resolveCapabilityInputSecrets } from '#mcp/secrets/capability-inputs.ts'
import {
	capabilityInputSecretAuthRequiredMessage,
	createCapabilitySecretAccessDeniedMessage,
	createCapabilitySecretAccessDeniedBatchMessage,
	createMissingSecretMessage,
} from '#mcp/secrets/errors.ts'
import { buildSecretCapabilityApprovalUrl } from '#mcp/secrets/capability-approval-url.ts'
import { resolveSecret } from '#mcp/secrets/service.ts'
import { type ReferencedSecret } from '#mcp/secrets/placeholders.ts'
import { buildParameterizedSkillCode } from '#mcp/skills/skill-parameters.ts'
import { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'

export async function buildCodemodeFns(
	env: Env,
	callerContext: McpCallerContext,
	options?: {
		resolveSecretValue?: (
			secret: ReferencedSecret,
			capabilityName: string,
		) => Promise<string>
	},
) {
	const { capabilityMap } = await getCapabilityRegistryForContext({
		env,
		callerContext,
	})
	return Object.fromEntries(
		Object.values(capabilityMap).map((capability) => [
			capability.name,
			async (args: unknown) => {
				const resolveSecretValue =
					options?.resolveSecretValue ??
					createCapabilityInputSecretResolver(
						env,
						callerContext,
						capability.name,
					)
				const resolvedArgs = await resolveCapabilityInputSecrets({
					schema: capability.inputSchema,
					value: (args ?? {}) as Record<string, unknown>,
					resolveSecretValue: (secret) =>
						resolveSecretValue(secret, capability.name),
				})
				return capability.handler(resolvedArgs as Record<string, unknown>, {
					env,
					callerContext,
				})
			},
		]),
	)
}

export async function buildCodemodeProvider(
	env: Env,
	callerContext: McpCallerContext,
): Promise<ResolvedProvider> {
	const tools = await buildCodemodeFns(env, callerContext)
	const provider: ToolProvider = {
		name: 'codemode',
		tools: Object.fromEntries(
			Object.entries(tools).map(([name, execute]) => [
				name,
				{
					execute,
				},
			]),
		),
	}
	return resolveProvider(provider)
}

function createCapabilityInputSecretResolver(
	env: Env,
	callerContext: McpCallerContext,
	capabilityName: string,
) {
	return async (secret: ReferencedSecret, _currentCapabilityName: string) => {
		const userId = callerContext.user?.userId ?? null
		if (!userId) {
			throw new Error(capabilityInputSecretAuthRequiredMessage)
		}
		const resolved = await resolveSecret({
			env,
			userId,
			name: secret.name,
			scope: secret.scope,
			storageContext: callerContext.storageContext
				? {
						sessionId: callerContext.storageContext.sessionId ?? null,
						appId: callerContext.storageContext.appId ?? null,
					}
				: null,
		})
		if (!resolved.found || typeof resolved.value !== 'string') {
			throw new Error(createMissingSecretMessage(secret.name))
		}
		if (!resolved.allowedCapabilities.includes(capabilityName)) {
			const approvalUrl = buildSecretCapabilityApprovalUrl({
				baseUrl: callerContext.baseUrl,
				name: secret.name,
				scope: resolved.scope ?? secret.scope ?? 'user',
				capabilityName,
				storageContext: callerContext.storageContext
					? {
							sessionId: callerContext.storageContext.sessionId ?? null,
							appId: callerContext.storageContext.appId ?? null,
						}
					: null,
			})
			throw new Error(
				createCapabilitySecretAccessDeniedMessage(
					secret.name,
					capabilityName,
					approvalUrl,
				),
			)
		}
		return resolved.value
	}
}


export async function runCodemodeWithRegistry(
	env: Env,
	callerContext: McpCallerContext,
	code: string,
	params?: Record<string, unknown>,
	executorExports?: typeof workerExports,
) {
	const { createExecuteExecutor } = await import('#mcp/executor.ts')
	const executor = createExecuteExecutor({
		env,
		exports: executorExports ?? workerExports,
		gatewayProps: {
			baseUrl: callerContext.baseUrl,
			userId: callerContext.user?.userId ?? null,
			storageContext: callerContext.storageContext
				? {
						sessionId: callerContext.storageContext.sessionId ?? null,
						appId: callerContext.storageContext.appId ?? null,
					}
				: null,
		},
	})
	const provider = await buildCodemodeProvider(env, callerContext)
	const wrapped =
		params !== undefined
			? await buildParameterizedSkillCode(code, params)
			: code
	const result = await executor.execute(wrapped, [provider])
	if (!result.error) return result
	const batchMessage = await rewriteCapabilitySecretError({
		error: result.error,
		code: wrapped,
		env,
		callerContext,
	})
	return batchMessage ? { ...result, error: batchMessage } : result
}

async function rewriteCapabilitySecretError(input: {
	error: unknown
	code: string
	env: Env
	callerContext: McpCallerContext
}) {
	const message =
		input.error instanceof Error ? input.error.message : String(input.error)
	const capabilityMatch = message.match(
		/^Secret "([^"]+)" is not allowed for capability "([^"]+)"/,
	)
	if (!capabilityMatch?.[1] || !capabilityMatch?.[2]) return null
	const capabilityName = capabilityMatch[2]
	const userId = input.callerContext.user?.userId ?? null
	if (!userId) return null
	const secretNames = collectSecretNamesFromCode(input.error, input.code)
	if (secretNames.length === 0) return null
	const missing = await findMissingCapabilityApprovals({
		env: input.env,
		userId,
		secretNames,
		capabilityName,
		storageContext: input.callerContext.storageContext ?? null,
		baseUrl: input.callerContext.baseUrl,
	})
	if (missing.length === 0) return null
	return createCapabilitySecretAccessDeniedBatchMessage(missing)
}

function collectSecretNamesFromCode(
	error: unknown,
	code: string | null,
) {
	const fromError =
		error instanceof Error ? parseSecretNamesFromMessage(error.message) : []
	const fromCode = code ? parseSecretNamesFromMessage(code) : []
	return normalizeSecretNameList([...fromError, ...fromCode])
}

function parseSecretNamesFromMessage(message: string) {
	const matches = Array.from(message.matchAll(/Secret "([^"]+)"/g))
	return matches
		.map((match) => match[1])
		.filter((value): value is string => Boolean(value))
}

function normalizeSecretNameList(names: Array<string>) {
	return Array.from(
		new Set(names.map((name) => name.trim()).filter((name) => name.length > 0)),
	).sort((left, right) => left.localeCompare(right))
}

async function findMissingCapabilityApprovals(input: {
	env: Env
	userId: string
	secretNames: Array<string>
	capabilityName: string
	storageContext: McpCallerContext['storageContext'] | null
	baseUrl: string
}) {
	const entries = await Promise.all(
		input.secretNames.map(async (name) => {
			const resolved = await resolveSecret({
				env: input.env,
				userId: input.userId,
				name,
				storageContext: input.storageContext,
			})
			if (!resolved.found) return null
			if (resolved.allowedCapabilities.includes(input.capabilityName)) {
				return null
			}
			const approvalUrl = buildSecretCapabilityApprovalUrl({
				baseUrl: input.baseUrl,
				name,
				scope: resolved.scope ?? 'user',
				capabilityName: input.capabilityName,
				storageContext: input.storageContext
					? {
							sessionId: input.storageContext.sessionId ?? null,
							appId: input.storageContext.appId ?? null,
						}
					: null,
			})
			return {
				secretName: name,
				capabilityName: input.capabilityName,
				approvalUrl,
			}
		}),
	)
	return entries.filter((entry): entry is NonNullable<typeof entry> => entry != null)
}
