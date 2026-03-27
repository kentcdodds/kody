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
	createMissingSecretMessage,
} from '#mcp/secrets/errors.ts'
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
		const isRestricted = resolved.allowedCapabilities.length > 0
		if (
			isRestricted &&
			!resolved.allowedCapabilities.includes(capabilityName)
		) {
			throw new Error(
				createCapabilitySecretAccessDeniedMessage(secret.name, capabilityName),
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
			storageContext: {
				sessionId: callerContext.storageContext?.sessionId ?? null,
				appId: callerContext.storageContext?.appId ?? null,
			},
		},
	})
	const provider = await buildCodemodeProvider(env, callerContext)
	const wrapped =
		params !== undefined
			? await buildParameterizedSkillCode(code, params)
			: code
	return executor.execute(wrapped, [provider])
}
