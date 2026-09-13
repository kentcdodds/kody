import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import type * as Destinations from '#worker/email/destinations.ts'
import { EmailDestinationError } from '#worker/email/destinations.ts'
import { identityEmailDestinationId } from '#universal/email-destinations.ts'

const mocks = vi.hoisted(() => ({
	listEmailNotificationDestinations: vi.fn(),
	setDefaultEmailNotificationDestination: vi.fn(),
	removeEmailNotificationDestination: vi.fn(),
	loadEmailDestinationAccount: vi.fn(),
	createEmailDestinationVerification: vi.fn(),
}))

vi.mock('#worker/email/destinations.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof Destinations>()
	return {
		...actual,
		listEmailNotificationDestinations: mocks.listEmailNotificationDestinations,
		setDefaultEmailNotificationDestination:
			mocks.setDefaultEmailNotificationDestination,
		removeEmailNotificationDestination:
			mocks.removeEmailNotificationDestination,
		loadEmailDestinationAccount: mocks.loadEmailDestinationAccount,
	}
})

vi.mock('#worker/email/destination-verification.ts', () => ({
	createEmailDestinationVerification: mocks.createEmailDestinationVerification,
}))

const { emailDestinationListCapability } =
	await import('./email-destination-list.ts')
const { emailDestinationAddCapability } =
	await import('./email-destination-add.ts')
const { emailDestinationSetDefaultCapability } =
	await import('./email-destination-set-default.ts')
const { emailDestinationRemoveCapability } =
	await import('./email-destination-remove.ts')

function createUsersDb() {
	return {
		prepare: () => ({
			bind: () => ({
				first: async () => ({ email_verified_at: '2026-01-01T00:00:00.000Z' }),
			}),
		}),
	} as unknown as D1Database
}

function createEnv() {
	return { APP_DB: createUsersDb() } as Env
}

function createUserContext() {
	return createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-1',
			email: 'owner@example.com',
			displayName: 'Owner',
		},
	})
}

test('email destination capabilities list, add, set default, and remove through the shared service', async () => {
	const env = createEnv()
	const identity = {
		id: identityEmailDestinationId,
		email: 'owner@example.com',
		kind: 'identity' as const,
		verified: true,
		isDefault: true,
		canRemove: false,
	}
	const extra = {
		id: 'dest-1',
		email: 'phone@example.com',
		kind: 'additional' as const,
		verified: true,
		isDefault: false,
		canRemove: true,
	}
	mocks.listEmailNotificationDestinations.mockResolvedValueOnce([identity])
	mocks.loadEmailDestinationAccount.mockResolvedValue({
		id: 1,
		email: 'owner@example.com',
		emailVerifiedAt: '2026-01-01T00:00:00.000Z',
		stableUserId: 'user-1',
	})
	mocks.createEmailDestinationVerification.mockResolvedValueOnce({
		destination: extra,
		created: true,
	})
	mocks.setDefaultEmailNotificationDestination.mockResolvedValueOnce([
		{ ...identity, isDefault: false },
		{ ...extra, isDefault: true },
	])
	mocks.removeEmailNotificationDestination.mockResolvedValueOnce([identity])

	const listed = await emailDestinationListCapability.handler(
		{},
		{ env, callerContext: createUserContext() },
	)
	expect(listed).toEqual({
		destinations: [
			{
				id: 'identity',
				email: 'owner@example.com',
				kind: 'identity',
				verified: true,
				is_default: true,
				can_remove: false,
			},
		],
		additional_limit: 5,
		additional_remaining: 5,
	})

	const added = await emailDestinationAddCapability.handler(
		{ email: 'phone@example.com' },
		{ env, callerContext: createUserContext() },
	)
	expect(added.created).toBe(true)
	expect(added.destination.email).toBe('phone@example.com')
	expect(mocks.createEmailDestinationVerification).toHaveBeenCalledWith({
		env,
		userId: 1,
		email: 'phone@example.com',
		requestUrl: 'https://example.com',
	})

	const defaulted = await emailDestinationSetDefaultCapability.handler(
		{ id: 'dest-1' },
		{ env, callerContext: createUserContext() },
	)
	expect(defaulted.destinations[1]?.is_default).toBe(true)

	const removed = await emailDestinationRemoveCapability.handler(
		{ id: 'dest-1' },
		{ env, callerContext: createUserContext() },
	)
	expect(removed.destinations).toHaveLength(1)

	mocks.removeEmailNotificationDestination.mockRejectedValueOnce(
		new EmailDestinationError(
			'cannot_remove_identity',
			'The account email stays on the destination list. Change it from account settings.',
		),
	)
	await expect(
		emailDestinationRemoveCapability.handler(
			{ id: 'identity' },
			{ env, callerContext: createUserContext() },
		),
	).rejects.toThrow('The account email stays on the destination list')
})
