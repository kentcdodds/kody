import {
	resolveProvider,
	type ResolvedProvider,
	type ToolProvider,
} from '@cloudflare/codemode'
import { exports as workerExports } from 'cloudflare:workers'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { buildParameterizedSkillCode } from '#mcp/skills/skill-parameters.ts'
import { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'

export async function buildCodemodeFns(
	env: Env,
	callerContext: McpCallerContext,
) {
	const { capabilityHandlers } = await getCapabilityRegistryForContext({
		env,
		callerContext,
	})
	return Object.fromEntries(
		Object.entries(capabilityHandlers).map(([name, handler]) => [
			name,
			(args: unknown) =>
				handler((args ?? {}) as Record<string, unknown>, {
					env,
					callerContext,
				}),
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

export async function runCodemodeWithRegistry(
	env: Env,
	callerContext: McpCallerContext,
	code: string,
	params?: Record<string, unknown>,
	executorExports?: typeof workerExports,
) {
	const { createExecuteExecutor, wrapExecuteCode } =
		await import('#mcp/executor.ts')
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
	return executor.execute(wrapExecuteCode(wrapped), [provider])
}
