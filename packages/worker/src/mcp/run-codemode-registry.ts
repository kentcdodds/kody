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
		resolveSecretValue?: (secret: ReferencedSecret) => Promise<string>
	},
) {
	const { capabilityMap } = await getCapabilityRegistryForContext({
		env,
		callerContext,
	})
	const resolveSecretValue =
		options?.resolveSecretValue ??
		createCapabilityInputSecretResolver(env, callerContext)
	return Object.fromEntries(
		Object.values(capabilityMap).map((capability) => [
			capability.name,
			async (args: unknown) => {
				const resolvedArgs = await resolveCapabilityInputSecrets({
					schema: capability.inputSchema,
					value: (args ?? {}) as Record<string, unknown>,
					resolveSecretValue,
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
) {
	return async (secret: ReferencedSecret) => {
		const userId = callerContext.user?.userId ?? null
		if (!userId) {
			throw new Error(capabilityInputSecretAuthRequiredMessage)
		}
		const resolved = await resolveSecret({
			env,
			userId,
			name: secret.name,
			scope: secret.scope,
			secretContext: callerContext.secretContext
				? {
						sessionId: callerContext.secretContext.sessionId ?? null,
						appId: callerContext.secretContext.appId ?? null,
					}
				: null,
		})
		if (!resolved.found || typeof resolved.value !== 'string') {
			throw new Error(createMissingSecretMessage(secret.name))
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
			secretContext: {
				sessionId: callerContext.secretContext?.sessionId ?? null,
				appId: callerContext.secretContext?.appId ?? null,
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
