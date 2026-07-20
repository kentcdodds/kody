import { expect, test, vi } from 'vitest'
import { createProfileAvatarHandler } from './profile-avatar.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	getUserSocialRowByUsername: vi.fn(),
	getUserAvatarObject: vi.fn(),
	resolveUserStableId: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/community/social-repo.ts', () => ({
	getUserSocialRowByUsername: (...args: Array<unknown>) =>
		mocks.getUserSocialRowByUsername(...args),
}))

vi.mock('#worker/community/avatar.ts', () => ({
	parseUserAvatarCacheKey: (avatarKey: string) => {
		const match = /^user-avatars\/[^/]+\/([^/]+)$/.exec(avatarKey)
		return match?.[1] ?? null
	},
	getUserAvatarObject: (...args: Array<unknown>) =>
		mocks.getUserAvatarObject(...args),
}))

vi.mock('#worker/user-id.ts', () => ({
	resolveUserStableId: (...args: Array<unknown>) =>
		mocks.resolveUserStableId(...args),
}))

const publicRow = {
	id: 1,
	username: 'alice',
	email: 'alice@example.com',
	stable_user_id: 'stable-alice',
	display_name: 'Alice',
	bio: null,
	avatar_key: 'user-avatars/stable-alice/abcdef.png',
	profile_visibility: 'public' as const,
	created_at: '2026-01-01T00:00:00.000Z',
}

function createEnv() {
	return {
		APP_DB: {} as D1Database,
		COMMUNITY_ASSETS: {} as R2Bucket,
	} as Env
}

async function runHandler(
	request: Request,
	params: { username: string; cacheKey: string },
) {
	const handler = createProfileAvatarHandler(createEnv())
	return handler.handler({
		request,
		params,
		url: new URL(request.url),
	} as never)
}

test('profile avatar cache visibility, anon 404, and cacheKey mismatch', async () => {
	mocks.readAuthenticatedAppUser.mockResolvedValue(null)
	mocks.getUserSocialRowByUsername.mockResolvedValue(publicRow)
	mocks.getUserAvatarObject.mockResolvedValue({
		body: new Blob([Uint8Array.from([1, 2, 3])]).stream(),
		httpMetadata: { contentType: 'image/png' },
		httpEtag: '"etag"',
		size: 3,
	})

	const publicResponse = await runHandler(
		new Request('https://example.com/profiles/alice/avatar/abcdef.png'),
		{ username: 'alice', cacheKey: 'abcdef.png' },
	)
	expect(publicResponse.status).toBe(200)
	expect(publicResponse.headers.get('Cache-Control')).toBe(
		'public, max-age=31536000, immutable',
	)
	expect(publicResponse.headers.get('Content-Type')).toBe('image/png')

	mocks.readAuthenticatedAppUser.mockResolvedValue({
		userId: 1,
		email: 'alice@example.com',
		mcpUser: { userId: 'stable-alice' },
	})
	mocks.getUserSocialRowByUsername.mockResolvedValue({
		...publicRow,
		profile_visibility: 'private',
	})
	mocks.resolveUserStableId.mockResolvedValue('stable-alice')
	mocks.getUserAvatarObject.mockResolvedValue({
		body: new Blob([Uint8Array.from([9])]).stream(),
		httpMetadata: { contentType: 'image/png' },
		size: 1,
	})
	const privateResponse = await runHandler(
		new Request('https://example.com/profiles/alice/avatar/abcdef.png'),
		{ username: 'alice', cacheKey: 'abcdef.png' },
	)
	expect(privateResponse.status).toBe(200)
	expect(privateResponse.headers.get('Cache-Control')).toBe('private, no-store')

	mocks.readAuthenticatedAppUser.mockResolvedValue(null)
	mocks.getUserSocialRowByUsername.mockResolvedValue({
		...publicRow,
		profile_visibility: 'private',
	})
	mocks.getUserAvatarObject.mockClear()
	const anonPrivate = await runHandler(
		new Request('https://example.com/profiles/alice/avatar/abcdef.png'),
		{ username: 'alice', cacheKey: 'abcdef.png' },
	)
	expect(anonPrivate.status).toBe(404)
	expect(mocks.getUserAvatarObject).not.toHaveBeenCalled()

	mocks.getUserSocialRowByUsername.mockResolvedValue(publicRow)
	mocks.getUserAvatarObject.mockClear()
	const mismatch = await runHandler(
		new Request('https://example.com/profiles/alice/avatar/wrong.png'),
		{ username: 'alice', cacheKey: 'wrong.png' },
	)
	expect(mismatch.status).toBe(404)
	expect(mocks.getUserAvatarObject).not.toHaveBeenCalled()
})
