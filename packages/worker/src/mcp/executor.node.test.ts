import { expect, test } from 'vitest'
import { type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import {
	createCapabilitySecretAccessDeniedBatchMessage,
	createCapabilitySecretAccessDeniedMessage,
	createHostSecretAccessDeniedBatchMessage,
	createMissingSecretMessage,
} from '#mcp/secrets/errors.ts'
import {
	createExecuteExecutor,
	extractRawContent,
	formatExecutionOutput,
	formatLimitedExecutionOutput,
	getExecutionErrorDetails,
	limitExecutionResultValue,
} from './executor.ts'

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
		CodemodeFetchGateway: ({ props }: { props: unknown }) => ({ props }),
	} as never
}

function createGatewayProps(userId: string) {
	return {
		baseUrl: 'https://heykody.dev',
		userId,
		storageContext: null,
	}
}

test('createExecuteExecutor reuses stable dynamic worker ids until binding context or module graph changes', async () => {
	const fakeLoader = createFakeWorkerLoader()
	const env = createExecutorTestEnv(fakeLoader.loader)
	const exports = createExecutorTestExports()
	const providers = [
		{
			name: 'codemode',
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
			name: 'codemode',
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
			name: 'codemode',
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
	}).execute('async () => await codemode.search({ q: "ok" })', [
		{
			name: 'codemode',
			fns: {
				search: async () => ({ ok: true }),
			},
		},
	])
	const dispatchers = fakeLoader.evaluations[0]
	const result = await dispatchers?.codemode?.call('search', '{}')

	expect(JSON.parse(result ?? '{}')).toEqual({
		error: 'Execution has already completed.',
	})
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

	const errors = [
		capabilityError,
		new Error(createMissingSecretMessage('missingToken')),
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
