import { expect, test, vi } from 'vitest'

const sentryMock = vi.hoisted(() => ({
	isInitialized: vi.fn(() => true),
	getClient: vi.fn(() => ({ getOptions: () => ({ dsn: 'https://example' }) })),
	withScope: vi.fn((callback: (scope: ScopeStub) => void) => {
		callback(sentryMock.scope)
	}),
	captureException: vi.fn(),
	captureMessage: vi.fn(),
	scope: {
		setLevel: vi.fn(),
		setTag: vi.fn(),
		setContext: vi.fn(),
		setUser: vi.fn(),
	},
}))

type ScopeStub = typeof sentryMock.scope

vi.mock('@sentry/cloudflare', () => ({
	isInitialized: (...args: Array<unknown>) => sentryMock.isInitialized(...args),
	getClient: (...args: Array<unknown>) => sentryMock.getClient(...args),
	withScope: (...args: Array<unknown>) => sentryMock.withScope(...args),
	captureException: (...args: Array<unknown>) =>
		sentryMock.captureException(...args),
	captureMessage: (...args: Array<unknown>) =>
		sentryMock.captureMessage(...args),
	instrumentDurableObjectWithSentry: (
		_getOptions: unknown,
		durableObjectClass: unknown,
	) => durableObjectClass,
}))

const { logMcpEvent } = await import('./observability.ts')
const { McpCallerError } = await import('./caller-error.ts')
const { PackageSecretAccessDeniedError } =
	await import('./secrets/package-access.ts')
const { CommunityActionError } = await import('#worker/community/errors.ts')
const { EntitlementLimitError } = await import('#worker/entitlements/errors.ts')
const { UserCodeError } = await import('#worker/user-code-error.ts')

function captureMcpEvents(run: () => void) {
	sentryMock.captureException.mockClear()
	sentryMock.captureMessage.mockClear()
	sentryMock.withScope.mockClear()
	sentryMock.scope.setLevel.mockClear()
	sentryMock.scope.setUser.mockClear()

	const originalInfo = console.info
	const payloads: Array<string> = []
	console.info = ((tag: unknown, json?: unknown) => {
		if (tag === 'mcp-event' && typeof json === 'string') {
			payloads.push(json)
		}
	}) as typeof console.info
	try {
		run()
	} finally {
		console.info = originalInfo
	}
	return payloads
}

const callerFailureBase = {
	category: 'mcp',
	tool: 'capability',
	outcome: 'failure',
	durationMs: 3,
	baseUrl: 'https://example.com',
	hasUser: true,
	userId: 'user-1',
} as const

test('logMcpEvent keeps sandbox and caller failures off Sentry and still reports platform bugs', () => {
	const payloads = captureMcpEvents(() => {
		logMcpEvent({
			category: 'mcp',
			tool: 'execute',
			toolName: 'execute',
			outcome: 'failure',
			durationMs: 12,
			baseUrl: 'https://example.com',
			hasUser: true,
			userId: 'user-1',
			sandboxError: true,
			errorName: 'Unknown',
			errorMessage:
				'Notion API /data_sources/39977ef0-f2db-81c6-9147-000bd579e312/query failed: validation_error',
			cause: 'Notion API /data_sources/.../query failed: validation_error',
		})

		logMcpEvent({
			...callerFailureBase,
			capabilityName: 'search',
			failurePhase: 'handler',
			errorName: 'McpCallerError',
			errorMessage: 'Provide "query" or "domain".',
			cause: new McpCallerError('Provide "query" or "domain".'),
		})

		logMcpEvent({
			...callerFailureBase,
			tool: 'search',
			toolName: 'search',
			errorName: 'McpCallerError',
			errorMessage:
				'Unknown domain "skills". Available domains: account, packages.',
			cause: new McpCallerError(
				'Unknown domain "skills". Available domains: account, packages.',
			),
		})

		logMcpEvent({
			...callerFailureBase,
			capabilityName: 'repo_open_session',
			failurePhase: 'handler',
			errorName: 'Error',
			errorMessage: 'Opening the session failed.',
			cause: new Error('Opening the session failed.', {
				cause: new McpCallerError('Discard the current session first.'),
			}),
		})

		logMcpEvent({
			...callerFailureBase,
			capabilityName: 'value_get',
			failurePhase: 'parse_input',
			errorName: 'ZodError',
			errorMessage: 'name: Required',
			cause: new Error('name: Required'),
		})

		logMcpEvent({
			...callerFailureBase,
			tool: 'search',
			toolName: 'search',
			callerError: true,
			errorName: 'EntityBatchError',
			errorMessage: 'All entity lookups failed.',
		})

		logMcpEvent({
			...callerFailureBase,
			capabilityName: 'user_module_run',
			failurePhase: 'handler',
			errorName: 'UserCodeError',
			errorMessage: 'boom from user code',
			cause: new UserCodeError('boom from user code'),
		})

		logMcpEvent({
			...callerFailureBase,
			capabilityName: 'secret_set',
			domain: 'secrets',
			capabilitySource: 'builtin',
			failurePhase: 'handler',
			errorName: 'PackageSecretAccessDeniedError',
			errorMessage:
				'Secret "x-kodykoalaAccessToken" is not allowed for package "x".',
			cause: new PackageSecretAccessDeniedError(
				'Secret "x-kodykoalaAccessToken" is not allowed for package "x".',
			),
		})

		logMcpEvent({
			...callerFailureBase,
			capabilityName: 'community_rate',
			domain: 'community',
			capabilitySource: 'builtin',
			failurePhase: 'handler',
			errorName: 'CommunityActionError',
			errorMessage: 'Fork this community listing before rating it.',
			cause: new CommunityActionError(
				'Fork this community listing before rating it.',
			),
		})

		const entitlementLimitError = new EntitlementLimitError({
			resource: 'storage_bytes',
			plan: 'free',
			limit: 67_108_864,
			current: 449_966_219,
			upgradeHint:
				'Remove or finish existing storage bytes you no longer need, or upgrade your plan at /account/billing.',
		})
		logMcpEvent({
			...callerFailureBase,
			capabilityName: 'storage_query',
			domain: 'storage',
			capabilitySource: 'builtin',
			failurePhase: 'handler',
			errorName: 'EntitlementLimitError',
			errorMessage: entitlementLimitError.message,
			cause: entitlementLimitError,
		})
		logMcpEvent({
			...callerFailureBase,
			capabilityName: 'job_schedule_once',
			domain: 'jobs',
			capabilitySource: 'builtin',
			failurePhase: 'handler',
			errorName: 'Error',
			errorMessage: 'Scheduling failed.',
			cause: new Error('Scheduling failed.', {
				cause: new EntitlementLimitError({
					resource: 'scheduled_jobs',
					plan: 'free',
					limit: 10,
					current: 46,
					upgradeHint:
						'Remove or finish existing scheduled jobs you no longer need, or upgrade your plan at /account/billing.',
				}),
			}),
		})

		logMcpEvent({
			...callerFailureBase,
			capabilityName: 'remote:home:bond_shade_set_position',
			domain: 'remote:home',
			capabilitySource: 'remote-connector',
			failurePhase: 'handler',
			errorName: 'Error',
			errorMessage:
				'The connector "home" is not connected. Kody cannot use this connector until it reconnects. Ask the user to start or reconnect the connector and then try again.',
			cause: new Error(
				'The connector "home" is not connected. Kody cannot use this connector until it reconnects. Ask the user to start or reconnect the connector and then try again.',
			),
		})
	})

	expect(payloads).toHaveLength(12)
	expect(JSON.parse(payloads[0]!)).toMatchObject({
		tool: 'execute',
		outcome: 'failure',
		sandboxError: true,
	})
	expect(sentryMock.captureException).not.toHaveBeenCalled()
	expect(sentryMock.captureMessage).not.toHaveBeenCalled()

	captureMcpEvents(() => {
		logMcpEvent({
			...callerFailureBase,
			capabilityName: 'value_get',
			capabilitySource: 'builtin',
			sandboxError: false,
			failurePhase: 'handler',
			errorName: 'Error',
			errorMessage: 'platform handler blew up',
			cause: new Error('platform handler blew up'),
		})

		logMcpEvent({
			...callerFailureBase,
			capabilityName: 'package_get',
			failurePhase: 'handler',
			errorName: 'Error',
			errorMessage: 'D1 write failed.',
			cause: new Error('D1 write failed.', {
				cause: new Error('storage unavailable'),
			}),
		})

		logMcpEvent({
			...callerFailureBase,
			capabilityName: 'storage_query',
			domain: 'storage',
			capabilitySource: 'builtin',
			conversationId: 'conv-storage-1',
			storageId: 'storage-notes-1',
			failurePhase: 'handler',
			errorName: 'Error',
			errorMessage: 'no such table: notes: SQLITE_ERROR',
			context: {
				sqlPreview: 'SELECT * FROM notes LIMIT 1',
			},
			cause: new Error('no such table: notes: SQLITE_ERROR'),
		})

		logMcpEvent({
			...callerFailureBase,
			capabilityName: 'remote:home:bond_shade_set_position',
			domain: 'remote:home',
			capabilitySource: 'remote-connector',
			failurePhase: 'handler',
			errorName: 'Error',
			errorMessage:
				'Remote capability "home:bond_shade_set_position" failed: timeout',
			cause: new Error(
				'Remote capability "home:bond_shade_set_position" failed: timeout',
			),
		})
	})

	expect(sentryMock.captureException).toHaveBeenCalledTimes(4)
	expect(sentryMock.captureException).toHaveBeenNthCalledWith(
		1,
		expect.objectContaining({ message: 'platform handler blew up' }),
	)
	expect(sentryMock.captureException).toHaveBeenNthCalledWith(
		2,
		expect.objectContaining({ message: 'D1 write failed.' }),
	)
	expect(sentryMock.captureException).toHaveBeenNthCalledWith(
		3,
		expect.objectContaining({
			message: 'no such table: notes: SQLITE_ERROR',
		}),
	)
	expect(sentryMock.captureException).toHaveBeenNthCalledWith(
		4,
		expect.objectContaining({
			message:
				'Remote capability "home:bond_shade_set_position" failed: timeout',
		}),
	)
	expect(sentryMock.scope.setLevel).toHaveBeenCalledWith('error')
	expect(sentryMock.scope.setUser).toHaveBeenCalledWith({ id: 'user-1' })
	expect(sentryMock.scope.setContext).toHaveBeenCalledWith(
		'mcp',
		expect.objectContaining({
			baseUrl: 'https://example.com',
			hasUser: true,
			errorMessage: 'platform handler blew up',
			detail: undefined,
		}),
	)
	expect(sentryMock.scope.setContext).toHaveBeenCalledWith(
		'mcp',
		expect.objectContaining({
			conversationId: 'conv-storage-1',
			storageId: 'storage-notes-1',
			detail: {
				sqlPreview: 'SELECT * FROM notes LIMIT 1',
			},
		}),
	)
	expect(sentryMock.captureMessage).not.toHaveBeenCalled()
})
