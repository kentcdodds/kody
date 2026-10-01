import { afterEach, expect, test, vi } from 'vitest'
import { ApiError, invalidRequest } from './errors.ts'
import { type ApiInvocationContext } from './context.ts'
import { runCapabilityProxyCall } from './capability-proxy.ts'

const mockFns = vi.hoisted(() => ({
	buildKodyToolContext: vi.fn(),
}))

vi.mock('#mcp/run-kody-registry.ts', () => ({
	buildKodyToolContext: mockFns.buildKodyToolContext,
	createWorkflowTools: () => ({ create: async () => null }),
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	createExecutePackageInvokeTools: async () => ({ invoke: async () => null }),
}))

const secretValue = 'sk-live-very-secret-value'
const apiToken = `kody_at_${'a'.repeat(20)}_${'b'.repeat(43)}`

const ctx = {
	env: {},
	callerContext: { user: { userId: 'user-1' } },
	principal: { kind: 'mcp' },
	getFeatureFlags: async () => ({}),
} as unknown as ApiInvocationContext

function mockToolContext(secretSet: (args: unknown) => unknown) {
	mockFns.buildKodyToolContext.mockImplementation(
		async (
			_env: unknown,
			_callerContext: unknown,
			options: { trackSecretInputValue?: (value: string) => void },
		) => ({
			mcpServers: [],
			tools: {
				secret_set: async (args: { value: string }) => {
					options.trackSecretInputValue?.(args.value)
					return secretSet(args)
				},
			},
		}),
	)
}

async function callSecretSet() {
	return runCapabilityProxyCall({
		ctx,
		call: { path: ['kody', 'secret_set'], args: [{ value: secretValue }] },
	}).catch((error: unknown) => error)
}

afterEach(() => {
	mockFns.buildKodyToolContext.mockReset()
	vi.restoreAllMocks()
})

test('unexpected capability failures hide written secrets and API tokens', async () => {
	mockToolContext(() => {
		throw new Error(`write failed for ${secretValue} via ${apiToken}`)
	})
	const error = await callSecretSet()
	expect(error).toBeInstanceOf(ApiError)
	expect(error).toMatchObject({ status: 500, code: 'capability_error' })
	const message = (error as ApiError).message
	expect(message).toContain('write failed for [REDACTED SECRET]')
	expect(message).not.toContain(secretValue)
	expect(message).not.toContain(apiToken)
})

test('caller errors from a capability keep their status with secrets redacted', async () => {
	mockToolContext(() => {
		throw invalidRequest(`value ${secretValue} is too long`)
	})
	const error = await callSecretSet()
	expect(error).toMatchObject({
		status: 400,
		code: 'invalid_request',
		message: 'value [REDACTED SECRET] is too long',
	})
})

test('platform failures outside the capability return a generic error and log details', async () => {
	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	mockFns.buildKodyToolContext.mockRejectedValue(
		new Error('D1_ERROR: no such column: secret_ciphertext'),
	)
	const error = await callSecretSet()
	expect(error).toMatchObject({ status: 500, code: 'internal_error' })
	expect((error as ApiError).message).not.toContain('D1_ERROR')
	expect(consoleError).toHaveBeenCalledWith(
		'capability-proxy platform failure',
		expect.objectContaining({
			path: 'kody.secret_set',
			error: 'D1_ERROR: no such column: secret_ciphertext',
		}),
	)
})
