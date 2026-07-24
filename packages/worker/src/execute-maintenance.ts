import { exports as workerExports } from 'cloudflare:workers'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { createExecuteExecutor } from '#mcp/executor.ts'
import { handleSecretMaintenanceRequest } from './maintenance-handler.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'

const executeSmokeCode = 'async () => 42'
const executeSmokeProviders = [
	{
		name: 'kody',
		fns: {},
		kodyRemoteConnectors: [],
		kodyMcpServers: [],
	},
] as const

export async function runExecuteSmokeCheck(env: Env) {
	if (!env.LOADER) {
		throw new Error('Execute smoke check requires the LOADER binding.')
	}
	if (!workerExports?.KodyFetchGateway) {
		throw new Error(
			'Execute smoke check requires the KodyFetchGateway worker export.',
		)
	}

	const origin = getAppBaseUrl({ env })
	const executor = createExecuteExecutor({
		env,
		exports: workerExports,
		gatewayProps: {
			baseUrl: origin,
			userId: null,
			email: null,
			storageContext: null,
		},
		timeoutMs: 10_000,
	})
	const result = await executor.execute(executeSmokeCode, [
		...executeSmokeProviders,
	])
	if (result.error) {
		throw new Error(`Execute smoke check failed: ${result.error}`)
	}
	if (result.result !== 42) {
		throw new Error(
			`Execute smoke check returned unexpected result: ${getErrorMessage(result.result)}`,
		)
	}
	return { result: result.result }
}

export async function handleExecuteSmokeRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	return handleSecretMaintenanceRequest({
		request,
		secret: env.CAPABILITY_REINDEX_SECRET,
		notConfiguredMessage: 'Execute smoke check is not configured',
		run: async () => await runExecuteSmokeCheck(env),
	})
}
