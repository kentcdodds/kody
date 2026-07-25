import { expect, test, vi } from 'vitest'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { assertCallerCanAccessCapability } from './capabilities/access-control.ts'
import { createMcpCallerContext } from './context.ts'

const sentryMock = vi.hoisted(() => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}))

vi.mock('@sentry/cloudflare', () => ({
	isInitialized: () => true,
	getClient: () => ({
		getOptions: () => ({ dsn: 'https://audit@example.com/1' }),
	}),
	withScope: (run: (scope: unknown) => void) =>
		run({
			setLevel: vi.fn(),
			setUser: vi.fn(),
			setTag: vi.fn(),
			setContext: vi.fn(),
		}),
	captureException: sentryMock.captureException,
	captureMessage: sentryMock.captureMessage,
}))

const adminCapability = {
	name: 'admin_user_get',
	requiredRole: 'admin',
} as const

function memberContext(userId: string) {
	return createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: {
			userId,
			email: `${userId}@example.com`,
			displayName: userId,
			roles: ['user'],
			permissions: ['read:user:own'],
		},
	})
}

test('a single capability denial is audited without becoming a Sentry error', async () => {
	const callerContext = memberContext('user-1')

	await expect(
		assertCallerCanAccessCapability(callerContext, adminCapability),
	).rejects.toThrow(/lacks required role "admin"/)

	expect(auditEventSummaries()).toEqual(['mcp_capability_denied:failure'])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'mcp_capability_denied',
			result: 'failure',
			reason: 'role',
			email: 'user-1@example.com',
			path: 'admin_user_get',
		}),
	)
	expect(sentryMock.captureException).not.toHaveBeenCalled()
	expect(sentryMock.captureMessage).not.toHaveBeenCalled()
})

// The point of this one: routine denials are quiet, but a principal walking the
// capability surface must stay visible. If a future change silences denials the
// way an earlier revision of this work did, this test fails.
test('a principal enumerating admin capabilities stays visible in the audit log', async () => {
	const callerContext = memberContext('prober')
	const probedCapabilities = Array.from(
		{ length: 25 },
		(_, index) => `admin_capability_${index}`,
	)

	for (const name of probedCapabilities) {
		await expect(
			assertCallerCanAccessCapability(callerContext, {
				name,
				requiredRole: 'admin',
			}),
		).rejects.toThrow(/lacks required role "admin"/)
	}

	const denials = logAuditEventSpy.mock.calls.map(([event]) => event)
	expect(denials).toHaveLength(probedCapabilities.length)
	expect(denials.every((event) => event.result === 'failure')).toBe(true)
	expect(denials.every((event) => event.category === 'auth')).toBe(true)

	// One principal against many distinct capabilities is the shape that
	// separates probing from an agent that simply called the wrong thing once.
	expect(new Set(denials.map((event) => event.email))).toEqual(
		new Set(['prober@example.com']),
	)
	expect(new Set(denials.map((event) => event.path))).toEqual(
		new Set(probedCapabilities),
	)
})

test('audit denials carry the raw identifier for the sink to hash, never a stored secret', async () => {
	await expect(
		assertCallerCanAccessCapability(
			createMcpCallerContext({ baseUrl: 'https://heykody.dev' }),
			adminCapability,
		),
	).rejects.toThrow(/Authenticated MCP user is required/)

	const [event] = logAuditEventSpy.mock.calls.at(-1) ?? []
	expect(event).toMatchObject({ reason: 'no_user', category: 'auth' })
	expect(event?.email).toBeUndefined()
})
