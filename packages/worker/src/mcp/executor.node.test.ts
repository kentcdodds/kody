import { expect, test } from 'vitest'
import { type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import {
	createCapabilitySecretAccessDeniedBatchMessage,
	createCapabilitySecretAccessDeniedMessage,
	createHostSecretAccessDeniedBatchMessage,
	createMissingSecretMessage,
} from '#mcp/secrets/errors.ts'
import { EntitlementLimitError } from '#worker/entitlements/errors.ts'
import {
	createKodyRemoteProxy,
	createKodyProviderProxySource,
	createExecuteExecutor,
	createExecutorModuleSource,
	createToolDispatchers,
	extractRawContent,
	formatExecutionOutput,
	formatLimitedExecutionOutput,
	getExecutionErrorDetails,
	limitExecutionResultValue,
} from './executor.ts'
import { assertGeneratedExecutorSourceIsBundleSafe } from './kody-remote-proxy-source.ts'

type FakeWorkerOptions = Record<string, unknown>

function createFakeWorkerLoader() {
	const ids: Array<string> = []
	const createdOptions = new Map<string, FakeWorkerOptions>()
	const evaluations: Array<
		Record<string, { call: typeof ToolDispatcherCall }>
	> = []
	let factoryCallCount = 0
	const loader = {
		get(id: string, factory: () => FakeWorkerOptions) {
			ids.push(id)
			let options = createdOptions.get(id)
			if (!options) {
				factoryCallCount += 1
				options = factory()
				createdOptions.set(id, options)
			}
			return {
				getEntrypoint() {
					return {
						async evaluate(
							dispatchers: Record<string, { call: typeof ToolDispatcherCall }>,
						) {
							evaluations.push(dispatchers)
							return {
								result: id,
								logs: [],
							}
						},
					}
				},
			}
		},
	} as unknown as Env['LOADER']
	return {
		loader,
		ids,
		createdOptions,
		evaluations,
		get factoryCallCount() {
			return factoryCallCount
		},
	}
}

async function ToolDispatcherCall(_name: string, _argsJson: string) {
	return ''
}

function createExecutorTestEnv(loader: Env['LOADER']) {
	return {
		LOADER: loader,
		APP_COMMIT_SHA: 'commit-for-test',
	} as Env
}

function createExecutorTestExports() {
	return {
		KodyFetchGateway: ({ props }: { props: unknown }) => ({ props }),
	} as never
}

function createGatewayProps(userId: string) {
	return {
		baseUrl: 'https://heykody.dev',
		userId,
		storageContext: null,
	}
}

test('kody remote proxy dispatches and reports connector/capability errors clearly', async () => {
	const calls: Array<{ dispatchName: string; args: unknown }> = []
	const remote = createKodyRemoteProxy({
		remoteConnectors: [
			{
				name: 'home',
				instanceId: 'home',
				status: {
					state: 'connected',
					connected: true,
					toolCount: 1,
					message: 'The connector "home" is connected.',
					unavailableMessage: 'The connector "home" is connected.',
				},
				capabilities: [
					{
						name: 'set_pin',
						dispatchName: 'remotehomeset_pin',
					},
				],
			},
			{
				name: 'lights',
				instanceId: 'home',
				status: {
					state: 'disconnected',
					connected: false,
					toolCount: 0,
					message: 'The connector "home" is not connected.',
					unavailableMessage:
						'The connector "home" is not connected. Kody cannot use this connector until it reconnects.',
				},
				capabilities: [],
			},
		],
		async callTool(dispatchName, args) {
			calls.push({ dispatchName, args })
			return { ok: true }
		},
	}) as Record<string, Record<string, (args: unknown) => Promise<unknown>>>

	await expect(remote['home']?.set_pin({ pin: '1234' })).resolves.toEqual({
		ok: true,
	})
	expect(calls).toEqual([
		{
			dispatchName: 'remotehomeset_pin',
			args: { pin: '1234' },
		},
	])
	expect(() => remote['missing']).toThrow(
		'Unknown remote connector "missing". Available remote connectors: "home", "lights".',
	)
	expect(() => remote['home']?.missing_tool).toThrow(
		'Unknown remote capability "missing_tool" for connector "home". Available capabilities: "set_pin".',
	)
	expect(() => remote['lights']?.set_pin).toThrow(
		'The connector "home" is not connected. Kody cannot use this connector until it reconnects.',
	)
})

test('generated kody provider source avoids bundle-scoped __name helpers', () => {
	const source = createKodyProviderProxySource({
		providerName: 'kody',
		remoteConnectors: [],
	})
	expect(source).not.toMatch(/\b__name\b/u)
	assertGeneratedExecutorSourceIsBundleSafe(source)

	const bundledFactorySource = `const __kodyCreateRemoteProxy = __name(function createKodyRemoteProxy() { return {}; }, "createKodyRemoteProxy");`
	expect(bundledFactorySource).toMatch(/\b__name\b/u)
	expect(() => new Function('__dispatchers', bundledFactorySource)({})).toThrow(
		/__name is not defined/u,
	)

	const moduleSource = createExecutorModuleSource({
		code: 'async () => "ok"',
		providers: [
			{
				name: 'kody',
				fns: {},
				kodyRemoteConnectors: [],
			},
		],
		shadowGlobalThis: false,
		timeoutMs: 1_000,
	})
	assertGeneratedExecutorSourceIsBundleSafe(moduleSource)
})

test('generated kody provider source wires remote proxy dispatch', async () => {
	const calls: Array<{ name: string; argsJson: string }> = []
	const source = createKodyProviderProxySource({
		providerName: 'kody',
		remoteConnectors: [
			{
				name: 'home',
				instanceId: 'home',
				status: {
					state: 'connected',
					connected: true,
					toolCount: 1,
					message: 'The connector "home" is connected.',
					unavailableMessage: 'The connector "home" is connected.',
				},
				capabilities: [
					{
						name: 'set_pin',
						dispatchName: 'remotehomeset_pin',
					},
				],
			},
		],
	})
	const kody = new Function('__dispatchers', `${source}; return kody;`)({
		kody: {
			async call(name: string, argsJson: string) {
				calls.push({ name, argsJson })
				return JSON.stringify({ result: { ok: true } })
			},
		},
	}) as {
		remote: Record<string, Record<string, (args: unknown) => Promise<unknown>>>
		[key: string]: unknown
	}

	await expect(kody.remote['home']?.set_pin({ pin: '1234' })).resolves.toEqual({
		ok: true,
	})
	expect(calls).toEqual([
		{
			name: 'remotehomeset_pin',
			argsJson: JSON.stringify({ pin: '1234' }),
		},
	])
	expect(() => kody['remote:home:set_pin']).toThrow(
		'Remote connector capability "remote:home:set_pin" is not available as a flat kody function.',
	)
})

test('generated kody provider source wires openapi proxy dispatch', async () => {
	const calls: Array<{ name: string; argsJson: string }> = []
	const source = createKodyProviderProxySource({
		providerName: 'kody',
		remoteConnectors: [],
		openApiProviders: [
			{
				name: 'widgets',
				bindingName: 'widgets',
				status: {
					state: 'connected',
					connected: true,
					toolCount: 1,
					message: 'The OpenAPI provider "widgets" is connected.',
					unavailableMessage: 'The OpenAPI provider "widgets" is connected.',
				},
				capabilities: [
					{
						name: 'listwidgets',
						dispatchName: 'openapiwidgetslistwidgets',
					},
				],
			},
		],
	})
	const kody = new Function('__dispatchers', `${source}; return kody;`)({
		kody: {
			async call(name: string, argsJson: string) {
				calls.push({ name, argsJson })
				return JSON.stringify({ result: { ok: true } })
			},
		},
	}) as {
		openapi: Record<string, Record<string, (args: unknown) => Promise<unknown>>>
		[key: string]: unknown
	}

	await expect(
		kody.openapi['widgets']?.listwidgets({ query: { limit: 1 } }),
	).resolves.toEqual({ ok: true })
	expect(calls).toEqual([
		{
			name: 'openapiwidgetslistwidgets',
			argsJson: JSON.stringify({ query: { limit: 1 } }),
		},
	])
	expect(() => kody.openapi['missing']).toThrow(
		'Unknown OpenAPI provider "missing". Available OpenAPI providers: "widgets".',
	)
	expect(() => kody.openapi['widgets']?.missing_op).toThrow(
		'Unknown operation "missing_op" for provider "widgets". Available capabilities: "listwidgets".',
	)
	expect(() => kody['openapi:widgets:listwidgets']).toThrow(
		'OpenAPI operation "openapi:widgets:listwidgets" is not available as a flat kody function. Use kody.openapi[providerName].operationSlug(input) instead.',
	)
})

test('createExecuteExecutor reuses stable dynamic worker ids until binding context or module graph changes', async () => {
	const fakeLoader = createFakeWorkerLoader()
	const env = createExecutorTestEnv(fakeLoader.loader)
	const exports = createExecutorTestExports()
	const providers = [
		{
			name: 'kody',
			fns: {
				search: async () => ({ ok: true }),
			},
		},
	]

	const first = await createExecuteExecutor({
		env,
		exports,
		gatewayProps: createGatewayProps('user-1'),
	}).execute('async () => "ok"', providers)
	const second = await createExecuteExecutor({
		env,
		exports,
		gatewayProps: createGatewayProps('user-1'),
	}).execute('async () => "ok"', [
		{
			name: 'kody',
			fns: {
				search: async () => ({ ok: 'different dispatcher same worker' }),
			},
		},
	])

	expect(first.result).toBe(second.result)
	expect(fakeLoader.ids).toHaveLength(2)
	expect(new Set(fakeLoader.ids).size).toBe(1)
	expect(fakeLoader.factoryCallCount).toBe(1)

	const scopedProviders = [
		{
			name: 'kody',
			fns: {},
		},
	]

	await createExecuteExecutor({
		env,
		exports,
		gatewayProps: createGatewayProps('user-1'),
		modules: {
			'helper.js': 'export const value = "one";',
		},
	}).execute('async () => "ok"', scopedProviders)
	await createExecuteExecutor({
		env,
		exports,
		gatewayProps: createGatewayProps('user-2'),
		modules: {
			'helper.js': 'export const value = "one";',
		},
	}).execute('async () => "ok"', scopedProviders)
	await createExecuteExecutor({
		env,
		exports,
		gatewayProps: createGatewayProps('user-1'),
		modules: {
			'helper.js': 'export const value = "two";',
		},
	}).execute('async () => "ok"', scopedProviders)

	expect(fakeLoader.ids).toHaveLength(5)
	expect(new Set(fakeLoader.ids).size).toBe(4)
	expect(fakeLoader.factoryCallCount).toBe(4)

	const noUserLoader = createFakeWorkerLoader()
	const noUserGatewayProps = {
		...createGatewayProps('user-1'),
		userId: null,
	}
	for (let index = 0; index < 2; index += 1) {
		await createExecuteExecutor({
			env: createExecutorTestEnv(noUserLoader.loader),
			exports,
			gatewayProps: noUserGatewayProps,
		}).execute('async () => "ok"', scopedProviders)
	}
	expect(noUserLoader.ids).toHaveLength(2)
	expect(new Set(noUserLoader.ids).size).toBe(2)
	expect(noUserLoader.factoryCallCount).toBe(2)

	const noCommitLoader = createFakeWorkerLoader()
	const noCommitEnv = {
		...createExecutorTestEnv(noCommitLoader.loader),
		APP_COMMIT_SHA: undefined,
	} as Env
	for (let index = 0; index < 2; index += 1) {
		await createExecuteExecutor({
			env: noCommitEnv,
			exports,
			gatewayProps: createGatewayProps('user-1'),
		}).execute('async () => "ok"', scopedProviders)
	}
	expect(noCommitLoader.ids).toHaveLength(2)
	expect(new Set(noCommitLoader.ids).size).toBe(2)
	expect(noCommitLoader.factoryCallCount).toBe(2)

	const bundledLoader = createFakeWorkerLoader()
	for (let index = 0; index < 2; index += 1) {
		await createExecuteExecutor({
			env: createExecutorTestEnv(bundledLoader.loader),
			exports,
			gatewayProps: createGatewayProps('user-1'),
			modules: {
				'entry.js': 'export default async function main() { return "ok" }',
			},
		}).execute('async () => "ok"', scopedProviders)
	}
	expect(bundledLoader.ids).toHaveLength(2)
	expect(new Set(bundledLoader.ids).size).toBe(1)
	expect(bundledLoader.factoryCallCount).toBe(1)

	const differentUserBundledLoader = createFakeWorkerLoader()
	for (const userId of ['user-1', 'user-2']) {
		await createExecuteExecutor({
			env: createExecutorTestEnv(differentUserBundledLoader.loader),
			exports,
			gatewayProps: createGatewayProps(userId),
			modules: {
				'entry.js': 'export default async function main() { return "ok" }',
			},
		}).execute('async () => "ok"', scopedProviders)
	}
	expect(differentUserBundledLoader.ids).toHaveLength(2)
	expect(new Set(differentUserBundledLoader.ids).size).toBe(2)
	expect(differentUserBundledLoader.factoryCallCount).toBe(2)

	const differentStorageLoader = createFakeWorkerLoader()
	const storageContexts = [
		null,
		{ sessionId: 'session-1', appId: 'app-1', storageId: 'storage-1' },
	] as const
	for (const storageContext of storageContexts) {
		await createExecuteExecutor({
			env: createExecutorTestEnv(differentStorageLoader.loader),
			exports,
			gatewayProps: {
				...createGatewayProps('user-1'),
				storageContext,
			},
			modules: {
				'entry.js': 'export default async function main() { return "ok" }',
			},
		}).execute('async () => "ok"', scopedProviders)
	}
	expect(differentStorageLoader.ids).toHaveLength(2)
	expect(new Set(differentStorageLoader.ids).size).toBe(2)
	expect(differentStorageLoader.factoryCallCount).toBe(2)

	const nonHashableModuleLoader = createFakeWorkerLoader()
	for (let index = 0; index < 2; index += 1) {
		await createExecuteExecutor({
			env: createExecutorTestEnv(nonHashableModuleLoader.loader),
			exports,
			gatewayProps: createGatewayProps('user-1'),
			modules: {
				'entry.js': {
					js: 'export default async function main() { return "ok" }',
					onLoad: async () => 'not-hashable',
				},
			},
		}).execute('async () => "ok"', scopedProviders)
	}
	expect(nonHashableModuleLoader.ids).toHaveLength(2)
	expect(new Set(nonHashableModuleLoader.ids).size).toBe(2)
	expect(nonHashableModuleLoader.factoryCallCount).toBe(2)
})

test('createExecuteExecutor records one usage event per sandbox run with duration and outcome', async () => {
	const dataPoints: Array<AnalyticsEngineDataPoint> = []
	const rollupWrites: Array<Array<unknown>> = []
	const usageBindings = {
		USAGE_EVENTS: {
			writeDataPoint(point?: AnalyticsEngineDataPoint) {
				if (point) dataPoints.push(point)
			},
		},
		APP_DB: {
			prepare(_sql: string) {
				return {
					bind(...args: Array<unknown>) {
						return {
							async run() {
								rollupWrites.push(args)
								return {}
							},
						}
					},
				}
			},
		},
	}
	const exports = createExecutorTestExports()
	const providers = [{ name: 'kody', fns: {} }]

	// Successful sandbox run: one success event.
	const successLoader = createFakeWorkerLoader()
	await createExecuteExecutor({
		env: {
			...createExecutorTestEnv(successLoader.loader),
			...usageBindings,
		} as Env,
		exports,
		gatewayProps: createGatewayProps('usage-user-1'),
	}).execute('async () => "ok"', providers)

	expect(dataPoints).toHaveLength(1)
	expect(dataPoints[0]?.indexes).toEqual(['usage-user-1'])
	expect(dataPoints[0]?.blobs?.slice(0, 4)).toEqual([
		'usage-user-1',
		'execute',
		'',
		'success',
	])
	expect(dataPoints[0]?.doubles?.[0]).toBeGreaterThanOrEqual(0)
	// With USAGE_EVENTS present, rollups are derived from Analytics Engine
	// by the scheduled aggregation instead of a per-event D1 upsert.
	expect(rollupWrites).toHaveLength(0)

	// Sandbox run returning an error result: one error event.
	const errorLoader = {
		get() {
			return {
				getEntrypoint() {
					return {
						async evaluate() {
							return { result: undefined, error: 'boom', logs: [] }
						},
					}
				},
			}
		},
	} as unknown as Env['LOADER']
	const errorResult = await createExecuteExecutor({
		env: {
			...createExecutorTestEnv(errorLoader),
			...usageBindings,
		} as Env,
		exports,
		gatewayProps: createGatewayProps('usage-user-1'),
	}).execute('async () => "ok"', providers)

	expect(errorResult.error).toBe('boom')
	expect(dataPoints).toHaveLength(2)
	expect(dataPoints[1]?.blobs?.[3]).toBe('error')
	expect(rollupWrites).toHaveLength(0)

	// Loader throwing: error event recorded, original error rethrown.
	const throwingLoader = {
		get() {
			throw new Error('loader unavailable')
		},
	} as unknown as Env['LOADER']
	await expect(
		createExecuteExecutor({
			env: {
				...createExecutorTestEnv(throwingLoader),
				...usageBindings,
			} as Env,
			exports,
			gatewayProps: createGatewayProps('usage-user-1'),
		}).execute('async () => "ok"', providers),
	).rejects.toThrow('loader unavailable')
	expect(dataPoints).toHaveLength(3)
	expect(dataPoints[2]?.blobs?.[3]).toBe('error')

	// No signed-in user: nothing recorded.
	const anonymousLoader = createFakeWorkerLoader()
	await createExecuteExecutor({
		env: {
			...createExecutorTestEnv(anonymousLoader.loader),
			...usageBindings,
		} as Env,
		exports,
		gatewayProps: { ...createGatewayProps('usage-user-1'), userId: null },
	}).execute('async () => "ok"', providers)
	expect(dataPoints).toHaveLength(3)
	expect(rollupWrites).toHaveLength(0)

	// Provider validation failure never reaches the sandbox: nothing recorded.
	const validationLoader = createFakeWorkerLoader()
	const validationResult = await createExecuteExecutor({
		env: {
			...createExecutorTestEnv(validationLoader.loader),
			...usageBindings,
		} as Env,
		exports,
		gatewayProps: createGatewayProps('usage-user-1'),
	}).execute('async () => "ok"', [{ name: 'class', fns: {} }])
	expect(validationResult.error).toContain('reserved')
	expect(dataPoints).toHaveLength(3)
	expect(rollupWrites).toHaveLength(0)
})

test('createExecuteExecutor rejects reserved JavaScript provider names before loading a worker', async () => {
	const fakeLoader = createFakeWorkerLoader()
	for (const name of ['class', 'private']) {
		const result = await createExecuteExecutor({
			env: createExecutorTestEnv(fakeLoader.loader),
			exports: createExecutorTestExports(),
			gatewayProps: createGatewayProps('user-1'),
		}).execute('async () => "ok"', [
			{
				name,
				fns: {},
			},
		])

		expect(result).toEqual({
			result: undefined,
			error: `Provider name "${name}" is a JavaScript reserved word`,
		})
	}
	expect(fakeLoader.factoryCallCount).toBe(0)
})

test('createExecuteExecutor disables dispatchers after execution completes', async () => {
	const fakeLoader = createFakeWorkerLoader()
	await createExecuteExecutor({
		env: createExecutorTestEnv(fakeLoader.loader),
		exports: createExecutorTestExports(),
		gatewayProps: createGatewayProps('user-1'),
	}).execute('async () => await kody.search({ q: "ok" })', [
		{
			name: 'kody',
			fns: {
				search: async () => ({ ok: true }),
			},
		},
	])
	const dispatchers = fakeLoader.evaluations[0]
	const result = await dispatchers?.kody?.call('search', '{}')

	expect(JSON.parse(result ?? '{}')).toEqual({
		error: 'Execution has already completed.',
	})
})

test('createToolDispatchers rejects duplicate sanitized tool names', () => {
	expect(() =>
		createToolDispatchers(
			[
				{
					name: 'kody',
					fns: {
						'remote:home:set_pin': async () => ({ ok: true }),
						remotehomeset_pin: async () => ({ ok: false }),
					},
				},
			],
			{ active: true },
		),
	).toThrow(
		'Provider "kody" has tool names "remote:home:set_pin" and "remotehomeset_pin" that both sanitize to "remotehomeset_pin".',
	)
})

test('executor maps secret errors, formats guidance, extracts raw content, and truncates on UTF-8 boundaries', () => {
	const capabilityError = new Error(
		createCapabilitySecretAccessDeniedMessage(
			'cloudflareToken',
			'secret_set',
			'https://example.com/account/secrets/user/cloudflareToken?capability=secret_set',
		),
	)
	expect(getExecutionErrorDetails(capabilityError)).toMatchObject({
		kind: 'secret_capability_access_required',
		secretNames: ['cloudflareToken'],
		capabilityName: 'secret_set',
		approvalUrl:
			'https://example.com/account/secrets/user/cloudflareToken?capability=secret_set',
		suggestedAction: {
			type: 'edit_secret_policy',
			policyField: 'allowed_capabilities',
		},
	})

	const capabilityBatchError = new Error(
		createCapabilitySecretAccessDeniedBatchMessage([
			{
				secretName: 'lutronUsername',
				capabilityName: 'lighting_lutron_set_credentials',
				approvalUrl:
					'https://example.com/account/secrets/user/lutronUsername?capability=lighting_lutron_set_credentials',
			},
			{
				secretName: 'lutronPassword',
				capabilityName: 'lighting_lutron_set_credentials',
				approvalUrl:
					'https://example.com/account/secrets/user/lutronPassword?capability=lighting_lutron_set_credentials',
			},
		]),
	)
	expect(getExecutionErrorDetails(capabilityBatchError)).toMatchObject({
		kind: 'secret_capability_access_required_batch',
		missingApprovals: [
			{
				secretName: 'lutronUsername',
				capabilityName: 'lighting_lutron_set_credentials',
			},
			{
				secretName: 'lutronPassword',
				capabilityName: 'lighting_lutron_set_credentials',
			},
		],
		suggestedAction: {
			type: 'edit_secret_policy',
			policyField: 'allowed_capabilities',
		},
	})

	const hostBatchError = new Error(
		createHostSecretAccessDeniedBatchMessage([
			{
				secretName: 'cloudflareToken',
				host: 'api.cloudflare.com',
				approvalUrl:
					'https://example.com/account/secrets/user/cloudflareToken?allowed-host=api.cloudflare.com',
			},
			{
				secretName: 'slackToken',
				host: 'slack.com',
				approvalUrl:
					'https://example.com/account/secrets/user/slackToken?allowed-host=slack.com',
			},
		]),
	)
	expect(getExecutionErrorDetails(hostBatchError)).toMatchObject({
		kind: 'host_approval_required_batch',
		missingApprovals: [
			{
				secretName: 'cloudflareToken',
				host: 'api.cloudflare.com',
			},
			{
				secretName: 'slackToken',
				host: 'slack.com',
			},
		],
		suggestedAction: {
			type: 'approve_secret_host',
		},
	})

	const entitlementError = new EntitlementLimitError({
		resource: 'saved_packages',
		plan: 'personal',
		limit: 3,
		current: 3,
		upgradeHint: 'Remove an old package or upgrade your plan.',
	})
	expect(getExecutionErrorDetails(entitlementError)).toMatchObject({
		kind: 'entitlement_limit_exceeded',
		details: {
			code: 'entitlement_limit_exceeded',
			resource: 'saved_packages',
			plan: 'personal',
			limit: 3,
			current: 3,
			upgradeHint: 'Remove an old package or upgrade your plan.',
		},
		suggestedAction: {
			type: 'review_plan_limit',
			resource: 'saved_packages',
		},
	})
	expect(
		getExecutionErrorDetails(new Error(entitlementError.message)),
	).toMatchObject({
		kind: 'entitlement_limit_exceeded',
		details: {
			code: 'entitlement_limit_exceeded',
			resource: 'saved_packages',
			plan: 'personal',
			limit: 3,
			current: 3,
			upgradeHint: 'Remove an old package or upgrade your plan.',
		},
	})

	// A bare ReferenceError for a kody:runtime export must point at the
	// missing import instead of leaving the caller to guess.
	expect(
		getExecutionErrorDetails(new Error('kody is not defined')),
	).toMatchObject({
		kind: 'runtime_import_missing',
		exportName: 'kody',
		nextStep: expect.stringContaining("import { kody } from 'kody:runtime'"),
		suggestedAction: { type: 'fix_code' },
	})
	expect(
		getExecutionErrorDetails(
			new Error('ReferenceError: secretHeaders is not defined'),
		),
	).toMatchObject({
		kind: 'runtime_import_missing',
		exportName: 'secretHeaders',
	})
	// Unknown identifiers stay unhinted: they are ordinary user-code bugs.
	expect(
		getExecutionErrorDetails(new Error('myHelper is not defined')),
	).toBeNull()

	const errors = [
		capabilityError,
		new Error(createMissingSecretMessage('missingToken')),
		new Error('kody is not defined'),
	]
	for (const error of errors) {
		const output = formatExecutionOutput({ error } as const)
		const plainOutput = `Error: ${error.message}`
		expect(output).toContain(plainOutput)
		expect(output.length).toBeGreaterThan(plainOutput.length)
	}

	const content: Array<ContentBlock> = [
		{
			type: 'image',
			data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
			mimeType: 'image/png',
		},
		{
			type: 'text',
			text: 'Screenshot of https://example.com',
		},
	]
	expect(
		extractRawContent({
			__mcpContent: content,
		}),
	).toEqual(content)
	expect(extractRawContent({ result: 'not raw content' })).toBeNull()

	const oneByteLimit = limitExecutionResultValue('éabc', 1)
	expect(oneByteLimit).toMatchObject({
		value: '',
		returnedBytes: 5,
		truncated: true,
	})

	const threeByteLimit = limitExecutionResultValue('éabc', 3)
	expect(threeByteLimit).toMatchObject({
		value: 'éa',
		returnedBytes: 5,
		truncated: true,
	})
	expect(
		new TextEncoder().encode(String(threeByteLimit.value)).byteLength,
	).toBe(3)
})

test('limitExecutionResultValue preserves output for representative small and oversized values', () => {
	const smallObject = { ok: true, count: 3 }
	const smallObjectLimited = limitExecutionResultValue(smallObject, 102_400)
	expect(smallObjectLimited).toMatchObject({
		value: smallObject,
		returnedBytes: 21,
		truncated: false,
	})
	expect(smallObjectLimited.displayText).toBe(
		JSON.stringify(smallObject, null, 2),
	)
	expect(
		formatLimitedExecutionOutput({
			value: smallObjectLimited.value,
			truncated: smallObjectLimited.truncated,
			displayText: smallObjectLimited.displayText,
		}),
	).toBe(smallObjectLimited.displayText)

	const oversizedObject = {
		rows: [{ id: 'message-1', payload: 'abcdef' }],
	}
	const oversizedObjectLimited = limitExecutionResultValue(oversizedObject, 10)
	expect(oversizedObjectLimited).toMatchObject({
		value: {
			truncated: true,
			type: 'object',
		},
		returnedBytes: 48,
		truncated: true,
		note: 'Returned value was 48 bytes, exceeding responseLimit 10 bytes; output was truncated. Project fields before returning.',
	})
	expect(
		formatLimitedExecutionOutput({
			value: oversizedObjectLimited.value,
			truncated: oversizedObjectLimited.truncated,
			note: oversizedObjectLimited.note,
			displayText: oversizedObjectLimited.displayText,
		}),
	).toBe(
		`${oversizedObjectLimited.displayText}\n\n--- TRUNCATED ---\n${oversizedObjectLimited.note}`,
	)

	const oversizedStringLimited = limitExecutionResultValue('hello world', 5)
	expect(oversizedStringLimited).toMatchObject({
		value: 'hello',
		returnedBytes: 11,
		truncated: true,
	})
	expect(oversizedStringLimited.displayText).toBeUndefined()
	expect(
		formatLimitedExecutionOutput({
			value: oversizedStringLimited.value,
			truncated: oversizedStringLimited.truncated,
			note: oversizedStringLimited.note,
		}),
	).toBe(`hello\n\n--- TRUNCATED ---\n${oversizedStringLimited.note}`)
})
