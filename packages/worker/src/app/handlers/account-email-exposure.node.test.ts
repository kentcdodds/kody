import { expect, test, vi } from 'vitest'
import type * as AccountEmailData from '#app/account-email-data.ts'

const loadAccountEmailDataMock = vi.hoisted(() =>
	vi.fn(async () => ({
		ok: true as const,
		emailVerified: true,
		email: 'user@example.com',
		username: 'test-user',
		inboxAddress: null,
		verificationMessage: null,
		inboxes: [],
		messages: [],
		selectedMessage: null,
		usage: null,
		page: 1,
		pageSize: 25,
		total: 0,
		query: '',
		classification: null,
	})),
)

vi.mock('#app/account-email-data.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AccountEmailData>()
	return {
		...actual,
		loadAccountEmailData: (...args: Array<unknown>) =>
			loadAccountEmailDataMock(...args),
	}
})

vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: vi.fn(async () => ({
		sessionUserId: '42',
		userId: 42,
		username: 'test-user',
		email: 'user@example.com',
		emailVerified: true,
		displayName: 'user',
		roles: ['user'],
		permissions: [],
		artifactOwnerIds: [],
		mcpUser: {
			userId: 'stable-user-1',
			email: 'user@example.com',
			username: 'test-user',
			displayName: 'user',
		},
	})),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: vi.fn(async () => ({
		sessionUserId: '42',
		userId: 42,
		username: 'test-user',
		email: 'user@example.com',
		emailVerified: true,
		displayName: 'user',
		roles: ['user'],
		permissions: [],
		artifactOwnerIds: [],
		mcpUser: {
			userId: 'stable-user-1',
			email: 'user@example.com',
			username: 'test-user',
			displayName: 'user',
		},
	})),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: vi.fn(async () => new Response('ok')),
}))

const { createAccountEmailHandler, createAccountEmailApiHandler } =
	await import('./account-email.ts')

test('SSR account email handler skips cutover exposure recording', async () => {
	loadAccountEmailDataMock.mockClear()
	const request = new Request('https://example.com/account/email')
	const handler = createAccountEmailHandler({} as Env)
	await handler.handler({ request, params: {} })
	expect(loadAccountEmailDataMock).toHaveBeenCalledWith(
		expect.objectContaining({
			request,
			skipCutoverExposureRecording: true,
		}),
	)
})

test('JSON account email API does not skip cutover exposure recording', async () => {
	loadAccountEmailDataMock.mockClear()
	const request = new Request('https://example.com/account/email.json')
	const handler = createAccountEmailApiHandler({} as Env)
	await handler.handler({ request })
	expect(loadAccountEmailDataMock).toHaveBeenCalledWith(
		expect.objectContaining({
			request,
		}),
	)
	expect(loadAccountEmailDataMock.mock.calls[0]?.[0]).not.toHaveProperty(
		'skipCutoverExposureRecording',
	)
})
