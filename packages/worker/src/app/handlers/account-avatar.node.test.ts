import { expect, test, vi } from 'vitest'
import { createAccountAvatarApiPostHandler } from './account-avatar.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	processUserAvatar: vi.fn(),
	saveUserAvatar: vi.fn(),
	deleteUserAvatar: vi.fn(),
	loadAccountProfileData: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/community/avatar.ts', () => ({
	processUserAvatar: (...args: Array<unknown>) =>
		mocks.processUserAvatar(...args),
	saveUserAvatar: (...args: Array<unknown>) => mocks.saveUserAvatar(...args),
	deleteUserAvatar: (...args: Array<unknown>) =>
		mocks.deleteUserAvatar(...args),
}))

vi.mock('#app/account-profile-data.ts', () => ({
	loadAccountProfileData: (...args: Array<unknown>) =>
		mocks.loadAccountProfileData(...args),
}))

const authedUser = {
	userId: 1,
	email: 'alice@example.com',
	emailVerified: true,
	username: 'alice',
	displayName: 'Alice',
	mcpUser: {
		userId: 'stable-alice',
		email: 'alice@example.com',
		displayName: 'Alice',
		username: 'alice',
	},
}

const profilePayload = {
	ok: true as const,
	email: 'alice@example.com',
	emailVerified: true,
	username: 'alice',
	displayName: 'Alice',
	bio: null,
	avatarUrl: '/profiles/alice/avatar/hash.png',
	profileVisibility: 'public' as const,
}

function createEnv() {
	return {
		APP_DB: {} as D1Database,
		COMMUNITY_ASSETS: {} as R2Bucket,
	} as Env
}

test('account avatar API auth, upload, remove, and invalid type', async () => {
	const handler = createAccountAvatarApiPostHandler(createEnv())

	mocks.readAuthenticatedAppUser.mockResolvedValue(null)
	const unauthorized = await handler.handler({
		request: new Request('http://example.com/account/profile/avatar.json', {
			method: 'POST',
		}),
		url: new URL('http://example.com/account/profile/avatar.json'),
		params: {},
	} as never)
	expect(unauthorized.status).toBe(401)
	expect((await unauthorized.json()).ok).toBe(false)

	mocks.readAuthenticatedAppUser.mockResolvedValue(authedUser)
	mocks.processUserAvatar.mockReturnValue({
		bytes: Uint8Array.from([1, 2, 3]),
		contentType: 'image/png',
	})
	mocks.saveUserAvatar.mockResolvedValue('user-avatars/stable-alice/hash.png')
	mocks.loadAccountProfileData.mockResolvedValue(profilePayload)

	const form = new FormData()
	form.set(
		'avatar',
		new File([Uint8Array.from([1, 2, 3])], 'avatar.png', {
			type: 'image/png',
		}),
	)
	const upload = await handler.handler({
		request: new Request('http://example.com/account/profile/avatar.json', {
			method: 'POST',
			body: form,
		}),
		url: new URL('http://example.com/account/profile/avatar.json'),
		params: {},
	} as never)
	expect(upload.status).toBe(200)
	expect(await upload.json()).toEqual(profilePayload)
	expect(mocks.saveUserAvatar).toHaveBeenCalledWith(
		expect.objectContaining({
			numericUserId: 1,
			stableUserId: 'stable-alice',
			contentType: 'image/png',
		}),
	)

	mocks.deleteUserAvatar.mockResolvedValue(undefined)
	mocks.loadAccountProfileData.mockResolvedValue({
		...profilePayload,
		avatarUrl: null,
	})
	const remove = await handler.handler({
		request: new Request('http://example.com/account/profile/avatar.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ remove: true }),
		}),
		url: new URL('http://example.com/account/profile/avatar.json'),
		params: {},
	} as never)
	expect(remove.status).toBe(200)
	expect(await remove.json()).toMatchObject({ avatarUrl: null })
	expect(mocks.deleteUserAvatar).toHaveBeenCalledWith(
		expect.objectContaining({
			numericUserId: 1,
			stableUserId: 'stable-alice',
		}),
	)

	mocks.processUserAvatar.mockImplementation(() => {
		throw new Error('Avatars must be PNG, JPEG, or WebP images.')
	})
	const invalidForm = new FormData()
	invalidForm.set(
		'avatar',
		new File([Uint8Array.from([1])], 'avatar.svg', { type: 'image/svg+xml' }),
	)
	const invalid = await handler.handler({
		request: new Request('http://example.com/account/profile/avatar.json', {
			method: 'POST',
			body: invalidForm,
		}),
		url: new URL('http://example.com/account/profile/avatar.json'),
		params: {},
	} as never)
	expect(invalid.status).toBe(400)
	expect((await invalid.json()).ok).toBe(false)
})
