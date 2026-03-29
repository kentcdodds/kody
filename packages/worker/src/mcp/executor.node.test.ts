import { expect, test } from 'vitest'
import {
	createCapabilitySecretAccessDeniedBatchMessage,
	createCapabilitySecretAccessDeniedMessage,
	createHostSecretAccessDeniedBatchMessage,
	createMissingSecretMessage,
} from '#mcp/secrets/errors.ts'
import {
	createExecuteExecutor,
	formatExecutionOutput,
	getExecutionErrorDetails,
} from './executor.ts'

function createTestLoader(): WorkerLoader {
	return {
		get(_name, getCode) {
			return {
				getEntrypoint() {
					return {
						async evaluate(dispatchers: Record<string, { call: (name: string, argsJson: string) => Promise<string> }>) {
							const workerCode = await getCode()
							const modules = Object.fromEntries(
								Object.entries(workerCode.modules).map(([key, value]) => [
									key,
									typeof value === 'string' ? value : (value.js ?? ''),
								]),
							)
							const source = modules['executor.js']
							if (!source) {
								throw new Error('Missing executor.js module.')
							}
							const moduleCache = new Map<string, Promise<unknown>>()
							const loadModule = async (specifier: string): Promise<unknown> => {
								const cached = moduleCache.get(specifier)
								if (cached) return cached
								const moduleSource = modules[specifier]
								if (!moduleSource) {
									throw new Error(`Unknown module: ${specifier}`)
								}
								const modulePromise = (async () => {
									const exports: Record<string, unknown> = Object.create(null)
									const exportNames = Array.from(
										moduleSource.matchAll(
											/export\s+(?:async\s+function|function|const|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
										),
									).map((match) => match[1]!)
									const transformed = moduleSource
										.replace(
											/import\s+\{\s*([^}]+)\s*\}\s+from\s+["']([^"']+)["'];?/g,
											(_match, names, importSpecifier) =>
												`const { ${names.trim()} } = await __importModule(${JSON.stringify(importSpecifier)});`,
										)
										.replace(
											/import\s+\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+["']([^"']+)["'];?/g,
											(_match, name, importSpecifier) =>
												`const ${name} = await __importModule(${JSON.stringify(importSpecifier)});`,
										)
										.replace(
											/export default class\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
											'class $1',
										)
										.replace(
											/export default async \(\)\s*=>/g,
											'exports.default = async () =>',
										)
										.replace(
											/export default /g,
											'exports.default = ',
										)
										.replace(
											/export async function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
											'exports.$1 = async function $1',
										)
										.replace(
											/export function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
											'exports.$1 = function $1',
										)
										.replace(
											/export const\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
											'exports.$1 =',
										)
									const evaluator = new Function(
										'exports',
										'__importModule',
										`return (async () => { ${transformed}\n${exportNames
											.map((name) => `exports.${name} = ${name};`)
											.join('\n')} })();`,
									)
									await evaluator(exports, loadModule)
									return exports
								})()
								moduleCache.set(specifier, modulePromise)
								return await modulePromise
							}
							const cloudflareWorkersExports = {
								WorkerEntrypoint: class {
									constructor(
										readonly ctx: { props?: unknown } = {},
										readonly env: unknown = {},
									) {}
								},
							}
							const mainModule = source.replace(
								/import\s+\{\s*WorkerEntrypoint\s*\}\s+from\s+"cloudflare:workers";?/g,
								'const { WorkerEntrypoint } = __cloudflareWorkers;',
							)
							const transformed = mainModule
								.replace(
									/export default class\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
									'class $1',
								)
								.replace(
									/import\s+\{\s*([^}]+)\s*\}\s+from\s+"([^"]+)";?/g,
									(_match, names, importSpecifier) =>
										`const { ${names.trim()} } = await __importModule(${JSON.stringify(importSpecifier)});`,
								)
							const exportsObject: Record<string, unknown> = Object.create(null)
							const evaluator = new Function(
								'exports',
								'__dispatchers',
								'__importModule',
								'__cloudflareWorkers',
								`return (async () => { ${transformed}
if (typeof CodeExecutor !== 'undefined') exports.default = CodeExecutor;
return exports.default; })();`,
							)
							const EntrypointClass = (await evaluator(
								exportsObject,
								dispatchers,
								loadModule,
								cloudflareWorkersExports,
							)) as {
								new (
									ctx: { props?: unknown },
									env: unknown,
								): { evaluate(dispatchers: Record<string, unknown>): Promise<unknown> }
							}
							const instance = new EntrypointClass({}, {})
							return instance.evaluate(dispatchers)
						},
					}
				},
			}
		},
	}
}

test('createExecuteExecutor returns results for async arrow execute code', async () => {
	const executor = createExecuteExecutor({
		env: {
			LOADER: createTestLoader(),
		} as Env,
		exports: {
			CodemodeFetchGateway() {
				return {} as Fetcher
			},
		} as typeof import('cloudflare:workers').exports,
		gatewayProps: {
			baseUrl: 'https://kody.example',
			userId: 'user-123',
			storageContext: null,
		},
	})

	const result = await executor.execute(
		`async () =>
			await codemode.ui_save_app({
				title: 'Execute generated app',
				description: 'Saved through execute.',
				keywords: ['execute', 'ui'],
				code: '<main><h1>Execute App</h1></main>',
			})`,
		[
			{
				name: 'codemode',
				fns: {
					async ui_save_app() {
						return {
							app_id: 'app-123',
							hosted_url: 'https://kody.example/ui/app-123',
						}
					},
				},
			},
		],
	)

	expect(result).toEqual({
		result: {
			app_id: 'app-123',
			hosted_url: 'https://kody.example/ui/app-123',
		},
		logs: [],
	})
})

test('getExecutionErrorDetails returns concrete guidance for capability access denial', () => {
	const error = new Error(
		createCapabilitySecretAccessDeniedMessage(
			'cloudflareToken',
			'cloudflare_rest',
			'https://example.com/account/secrets/user/cloudflareToken?capability=cloudflare_rest',
		),
	)

	expect(getExecutionErrorDetails(error)).toEqual({
		kind: 'secret_capability_access_required',
		message:
			'Secret "cloudflareToken" is not allowed for capability "cloudflare_rest". If this capability should be able to use the secret, ask the user whether to add "cloudflare_rest" to the secret\'s allowed capabilities in the account secrets UI, then retry after they approve that policy change. Approval link: https://example.com/account/secrets/user/cloudflareToken?capability=cloudflare_rest',
		nextStep:
			"Ask the user whether this capability should be allowed to use the secret. If they approve, help them add this capability name to the secret's allowed capabilities in the account secrets UI, then retry.",
		secretNames: ['cloudflareToken'],
		capabilityName: 'cloudflare_rest',
		approvalUrl:
			'https://example.com/account/secrets/user/cloudflareToken?capability=cloudflare_rest',
		suggestedAction: {
			type: 'edit_secret_policy',
			policyField: 'allowed_capabilities',
		},
	})
})

test('formatExecutionOutput includes capability access next step', () => {
	const result = {
		error: new Error(
			createCapabilitySecretAccessDeniedMessage(
				'cloudflareToken',
				'cloudflare_rest',
				'https://example.com/account/secrets/user/cloudflareToken?capability=cloudflare_rest',
			),
		),
	} as const

	expect(formatExecutionOutput(result)).toContain(
		"Next step: Ask the user whether this capability should be allowed to use the secret. If they approve, help them add this capability name to the secret's allowed capabilities in the account secrets UI, then retry.",
	)
})

test('formatExecutionOutput keeps missing secret guidance intact', () => {
	const result = {
		error: new Error(createMissingSecretMessage('missingToken')),
	} as const

	expect(formatExecutionOutput(result)).toContain(
		'Open a generated UI so the user can provide and save this secret',
	)
})

test('getExecutionErrorDetails returns batch capability approvals', () => {
	const error = new Error(
		createCapabilitySecretAccessDeniedBatchMessage([
			{
				secretName: 'lutronUsername',
				capabilityName: 'home_lutron_set_credentials',
				approvalUrl:
					'https://example.com/account/secrets/user/lutronUsername?capability=home_lutron_set_credentials',
			},
			{
				secretName: 'lutronPassword',
				capabilityName: 'home_lutron_set_credentials',
				approvalUrl:
					'https://example.com/account/secrets/user/lutronPassword?capability=home_lutron_set_credentials',
			},
		]),
	)

	expect(getExecutionErrorDetails(error)).toEqual({
		kind: 'secret_capability_access_required_batch',
		message:
			'Secrets require capability approval: [{"secretName":"lutronUsername","capabilityName":"home_lutron_set_credentials","approvalUrl":"https://example.com/account/secrets/user/lutronUsername?capability=home_lutron_set_credentials"},{"secretName":"lutronPassword","capabilityName":"home_lutron_set_credentials","approvalUrl":"https://example.com/account/secrets/user/lutronPassword?capability=home_lutron_set_credentials"}]',
		nextStep:
			'Ask the user whether they want to approve these capabilities for the listed secrets in the account secrets UI, then retry after approval.',
		missingApprovals: [
			{
				secretName: 'lutronUsername',
				capabilityName: 'home_lutron_set_credentials',
				approvalUrl:
					'https://example.com/account/secrets/user/lutronUsername?capability=home_lutron_set_credentials',
			},
			{
				secretName: 'lutronPassword',
				capabilityName: 'home_lutron_set_credentials',
				approvalUrl:
					'https://example.com/account/secrets/user/lutronPassword?capability=home_lutron_set_credentials',
			},
		],
		suggestedAction: {
			type: 'edit_secret_policy',
			policyField: 'allowed_capabilities',
		},
	})
})

test('getExecutionErrorDetails returns batch host approvals', () => {
	const error = new Error(
		createHostSecretAccessDeniedBatchMessage([
			{
				secretName: 'cloudflareToken',
				host: 'api.cloudflare.com',
				approvalUrl:
					'https://example.com/account/secrets/user/cloudflareToken?allowed-host=api.cloudflare.com&request=token',
			},
			{
				secretName: 'slackToken',
				host: 'slack.com',
				approvalUrl:
					'https://example.com/account/secrets/user/slackToken?allowed-host=slack.com&request=token',
			},
		]),
	)

	expect(getExecutionErrorDetails(error)).toEqual({
		kind: 'host_approval_required_batch',
		message:
			'Secrets require host approval: [{"secretName":"cloudflareToken","host":"api.cloudflare.com","approvalUrl":"https://example.com/account/secrets/user/cloudflareToken?allowed-host=api.cloudflare.com&request=token"},{"secretName":"slackToken","host":"slack.com","approvalUrl":"https://example.com/account/secrets/user/slackToken?allowed-host=slack.com&request=token"}]',
		nextStep:
			'Ask the user whether they want to approve these hosts for the listed secrets in the account web UI, then retry after approval.',
		missingApprovals: [
			{
				secretName: 'cloudflareToken',
				host: 'api.cloudflare.com',
				approvalUrl:
					'https://example.com/account/secrets/user/cloudflareToken?allowed-host=api.cloudflare.com&request=token',
			},
			{
				secretName: 'slackToken',
				host: 'slack.com',
				approvalUrl:
					'https://example.com/account/secrets/user/slackToken?allowed-host=slack.com&request=token',
			},
		],
		suggestedAction: {
			type: 'approve_secret_host',
		},
	})
})
