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

test('createExecuteExecutor uses stable dynamic worker ids for identical code and caller-scoped bindings', async () => {
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
})

test('createExecuteExecutor separates dynamic worker ids by user binding context and module graph', async () => {
	const fakeLoader = createFakeWorkerLoader()
	const env = createExecutorTestEnv(fakeLoader.loader)
	const exports = createExecutorTestExports()
	const providers = [
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
	}).execute('async () => "ok"', providers)
	await createExecuteExecutor({
		env,
		exports,
		gatewayProps: createGatewayProps('user-2'),
		modules: {
			'helper.js': 'export const value = "one";',
		},
	}).execute('async () => "ok"', providers)
	await createExecuteExecutor({
		env,
		exports,
		gatewayProps: createGatewayProps('user-1'),
		modules: {
			'helper.js': 'export const value = "two";',
		},
	}).execute('async () => "ok"', providers)

	expect(fakeLoader.ids).toHaveLength(3)
	expect(new Set(fakeLoader.ids).size).toBe(3)
	expect(fakeLoader.factoryCallCount).toBe(3)
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

test('createExecuteExecutor clears timeout handles after execution settles', async () => {
	const fakeLoader = createFakeWorkerLoader()
	await createExecuteExecutor({
		env: createExecutorTestEnv(fakeLoader.loader),
		exports: createExecutorTestExports(),
		gatewayProps: createGatewayProps('user-1'),
	}).execute('async () => "ok"', [
		{
			name: 'codemode',
			fns: {},
		},
	])
	const workerId = fakeLoader.ids[0]
	if (!workerId) throw new Error('Expected worker id')
	const options = fakeLoader.createdOptions.get(workerId)
	const modules = options?.modules as Record<string, string> | undefined
	const executorModule = modules?.['executor.js']

	expect(executorModule).toContain('let __timeoutId;')
	expect(executorModule).toContain('__timeoutId = setTimeout(')
	expect(executorModule).toContain('clearTimeout(__timeoutId);')
	expect(executorModule).toContain('const __kodySandboxGlobal = new Proxy')
	expect(executorModule).toContain('(async (globalThis, self, global) => (')
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

test('createExecuteExecutor keeps random worker ids when user id is absent', async () => {
	const fakeLoader = createFakeWorkerLoader()
	const env = createExecutorTestEnv(fakeLoader.loader)
	const exports = createExecutorTestExports()
	const gatewayProps = {
		...createGatewayProps('user-1'),
		userId: null,
	}

	await createExecuteExecutor({
		env,
		exports,
		gatewayProps,
	}).execute('async () => "ok"', [
		{
			name: 'codemode',
			fns: {},
		},
	])
	await createExecuteExecutor({
		env,
		exports,
		gatewayProps,
	}).execute('async () => "ok"', [
		{
			name: 'codemode',
			fns: {},
		},
	])

	expect(fakeLoader.ids).toHaveLength(2)
	expect(new Set(fakeLoader.ids).size).toBe(2)
	expect(fakeLoader.factoryCallCount).toBe(2)
})

test('createExecuteExecutor keeps random worker ids when app commit is absent', async () => {
	const fakeLoader = createFakeWorkerLoader()
	const env = {
		...createExecutorTestEnv(fakeLoader.loader),
		APP_COMMIT_SHA: undefined,
	} as Env
	const exports = createExecutorTestExports()

	for (let index = 0; index < 2; index += 1) {
		await createExecuteExecutor({
			env,
			exports,
			gatewayProps: createGatewayProps('user-1'),
		}).execute('async () => "ok"', [
			{
				name: 'codemode',
				fns: {},
			},
		])
	}

	expect(fakeLoader.ids).toHaveLength(2)
	expect(new Set(fakeLoader.ids).size).toBe(2)
	expect(fakeLoader.factoryCallCount).toBe(2)
})

test('createExecuteExecutor keeps random worker ids for bundled module graphs', async () => {
	const fakeLoader = createFakeWorkerLoader()
	const env = createExecutorTestEnv(fakeLoader.loader)
	const exports = createExecutorTestExports()

	for (let index = 0; index < 2; index += 1) {
		await createExecuteExecutor({
			env,
			exports,
			gatewayProps: createGatewayProps('user-1'),
			modules: {
				'entry.js': 'export default async function main() { return "ok" }',
			},
		}).execute('async () => "ok"', [
			{
				name: 'codemode',
				fns: {},
			},
		])
	}

	expect(fakeLoader.ids).toHaveLength(2)
	expect(new Set(fakeLoader.ids).size).toBe(2)
	expect(fakeLoader.factoryCallCount).toBe(2)
	const options = fakeLoader.createdOptions.get(fakeLoader.ids[0] ?? '')
	const modules = options?.modules as Record<string, string> | undefined
	expect(modules?.['executor.js']).not.toContain('__kodySandboxGlobal')
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
