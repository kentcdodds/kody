import { type McpCallerContext } from '#shared/chat.ts'

export async function buildCodemodeFns(
	env: Env,
	callerContext: McpCallerContext,
) {
	const { capabilityHandlers } = await import('#mcp/capabilities/registry.ts')
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

export async function runCodemodeWithRegistry(
	env: Env,
	callerContext: McpCallerContext,
	code: string,
) {
	const { createExecuteExecutor, wrapExecuteCode } =
		await import('#mcp/executor.ts')
	const executor = createExecuteExecutor(env)
	const fns = await buildCodemodeFns(env, callerContext)
	return executor.execute(wrapExecuteCode(code), fns)
}
