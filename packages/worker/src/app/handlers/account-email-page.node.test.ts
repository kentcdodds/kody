import { expect, test, vi } from 'vitest'
import { createAccountEmailHandler } from '#app/handlers/account-email.ts'
import { loadAccountEmailData } from '#app/account-email-data.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import {
	listEmailNotificationDestinations,
	maxAdditionalEmailNotificationDestinations,
} from '#worker/email/destinations.ts'
import { identityEmailDestinationId } from '#universal/email-destinations.ts'

vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: vi.fn(),
}))

vi.mock('#app/account-email-data.ts', () => ({
	loadAccountEmailData: vi.fn(),
}))

vi.mock('#worker/email/destinations.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#worker/email/destinations.ts')>()
	return {
		...actual,
		listEmailNotificationDestinations: vi.fn(),
	}
})

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: vi.fn(async ({ loaderData }) =>
		Response.json({ ok: true, loaderData }),
	),
}))

test('email inbox SSR includes destinations and not just the message list', async () => {
	vi.mocked(requireAuthenticatedPageUser).mockResolvedValue({
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
	} as never)
	vi.mocked(loadAccountEmailData).mockResolvedValue({
		ok: true,
		emailVerified: true,
		email: 'user@example.com',
		username: 'test-user',
		inboxAddress: 'test-user@inbox.example.com',
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
	})
	vi.mocked(listEmailNotificationDestinations).mockResolvedValue([
		{
			id: identityEmailDestinationId,
			email: 'user@example.com',
			kind: 'identity',
			verified: true,
			isDefault: true,
			canRemove: false,
		},
	])

	const response = await createAccountEmailHandler({} as Env).handler({
		request: new Request('https://example.com/account/email'),
		params: {},
	} as never)
	expect(await response.json()).toEqual({
		ok: true,
		loaderData: {
			accountEmail: expect.objectContaining({
				ok: true,
				email: 'user@example.com',
			}),
			accountEmailDestinations: {
				ok: true,
				destinations: [
					expect.objectContaining({
						id: identityEmailDestinationId,
						email: 'user@example.com',
					}),
				],
				additionalLimit: maxAdditionalEmailNotificationDestinations,
				additionalRemaining: maxAdditionalEmailNotificationDestinations,
			},
		},
	})
	expect(renderAppPage).toHaveBeenCalled()
})
