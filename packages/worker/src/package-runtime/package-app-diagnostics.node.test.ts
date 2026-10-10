import { expect, test } from 'vitest'

import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import {
	forwardRuntimeWorkerFetch,
	isPackageAppRuntimeThrownResponse,
	logPackageAppAuthFailed,
	packageAppRequestIdHeader,
	packageAppRuntimeErrorHeader,
	packageAppRuntimeRunIdHeader,
	stripPackageAppRuntimeRunId,
	withPackageAppRequestId,
} from './package-app-diagnostics.ts'

test('withPackageAppRequestId assigns a uuid and keeps a valid one', () => {
	const assigned = withPackageAppRequestId(
		new Request('https://example.com/@user-me/packages/notes?token=secret', {
			headers: { Cookie: 'kody_session=do-not-log' },
		}),
	)
	expect(assigned.requestId).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	)
	expect(assigned.request.headers.get('Cookie')).toBe('kody_session=do-not-log')
	expect(assigned.request.headers.get(packageAppRequestIdHeader)).toBe(
		assigned.requestId,
	)

	const keptRequest = new Request(
		'https://example.com/@user-me/packages/notes',
		{
			headers: { [packageAppRequestIdHeader]: assigned.requestId },
		},
	)
	const kept = withPackageAppRequestId(keptRequest)
	expect(kept.request).toBe(keptRequest)
	expect(kept.requestId).toBe(assigned.requestId)

	const replaced = withPackageAppRequestId(
		new Request('https://example.com/@user-me/packages/notes', {
			headers: { [packageAppRequestIdHeader]: 'not a uuid' },
		}),
	)
	expect(replaced.requestId).not.toBe('not a uuid')
})

test('auth failure log names the cookie presence and omits its value', () => {
	consoleWarn.mockImplementation(() => {})
	const { requestId } = withPackageAppRequestId(
		new Request('https://example.com/@user-me/packages/notes?token=secret'),
	)
	logPackageAppAuthFailed({
		requestId,
		method: 'GET',
		pathname: '/@user-me/packages/notes',
	})
	expect(consoleWarn).toHaveBeenCalledWith('package-app-auth-failed', {
		requestId,
		method: 'GET',
		pathname: '/@user-me/packages/notes',
		sessionCookiePresent: true,
	})
	expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain('do-not-log')
	expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain('token=secret')
})

test('stripPackageAppRuntimeRunId removes correlation and thrown-error headers', () => {
	const response = new Response('nope', {
		status: 500,
		headers: {
			[packageAppRuntimeRunIdHeader]: 'run-1',
			[packageAppRuntimeErrorHeader]: '1',
			'content-type': 'text/plain',
		},
	})
	expect(isPackageAppRuntimeThrownResponse(response)).toBe(true)
	const stripped = stripPackageAppRuntimeRunId(response)
	expect(stripped.runtimeRunId).toBe('run-1')
	expect(stripped.response.headers.get(packageAppRuntimeRunIdHeader)).toBeNull()
	expect(stripped.response.headers.get(packageAppRuntimeErrorHeader)).toBeNull()
	expect(stripped.response.headers.get('content-type')).toBe('text/plain')
	expect(stripped.response.status).toBe(500)
	expect(isPackageAppRuntimeThrownResponse(stripped.response)).toBe(false)
})

test('runtime worker forward logs a 500 with request id and run id, not cookies', async () => {
	consoleError.mockImplementation(() => {})
	const fetcher = {
		fetch: async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input)
			expect(request.headers.get('Cookie')).toBe('kody_session=do-not-log')
			expect(request.headers.get(packageAppRequestIdHeader)).toMatch(
				/^[0-9a-f-]{36}$/i,
			)
			return new Response('boom', {
				status: 500,
				headers: { [packageAppRuntimeRunIdHeader]: 'run-42' },
			})
		},
	}
	const response = await forwardRuntimeWorkerFetch(
		fetcher,
		new Request('https://example.com/@user-me/packages/notes?token=secret', {
			headers: { Cookie: 'kody_session=do-not-log' },
		}),
	)
	expect(response.status).toBe(500)
	expect(response.headers.get(packageAppRuntimeRunIdHeader)).toBeNull()
	expect(await response.text()).toBe('boom')
	const logged = consoleError.mock.calls.find(
		(call) => call[0] === 'package-app-http-error',
	)
	expect(logged?.[1]).toMatchObject({
		status: 500,
		pathname: '/@user-me/packages/notes',
		runtimeRunId: 'run-42',
		phase: 'runtime-worker-forward',
	})
	expect(JSON.stringify(consoleError.mock.calls)).not.toContain('do-not-log')
	expect(JSON.stringify(consoleError.mock.calls)).not.toContain('token=secret')
})

test('runtime worker forward logs thrown failures without the error message', async () => {
	consoleError.mockImplementation(() => {})
	const fetcher = {
		fetch: async () => {
			throw new Error('kody_session=do-not-log token=secret')
		},
	}
	await expect(
		forwardRuntimeWorkerFetch(
			fetcher,
			new Request('https://example.com/@user-me/packages/notes'),
		),
	).rejects.toThrow('do-not-log')
	expect(consoleError).toHaveBeenCalledWith(
		'runtime-worker-forward-failed',
		expect.objectContaining({
			pathname: '/@user-me/packages/notes',
			errorName: 'Error',
		}),
	)
	expect(JSON.stringify(consoleError.mock.calls)).not.toContain('do-not-log')
})
