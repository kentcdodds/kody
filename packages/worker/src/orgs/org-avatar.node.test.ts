import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	buildOrgAvatarR2Key,
	buildOrgAvatarUrl,
	parseOrgAvatarCacheKey,
	splitOrgAvatarCacheKey,
} from './org-avatar.ts'

test('org avatar keys use the org-avatars prefix and build a public URL', () => {
	const key = buildOrgAvatarR2Key({
		orgId: ownerIdFromStored('org-1'),
		contentHash: 'abcdef',
		contentType: 'image/png',
	})
	expect(key).toBe('org-avatars/org-1/abcdef.png')
	expect(parseOrgAvatarCacheKey(key)).toBe('abcdef.png')
	expect(splitOrgAvatarCacheKey('abcdef.png')).toEqual({
		hash: 'abcdef',
		ext: 'png',
	})
	expect(buildOrgAvatarUrl({ slug: 'acme', avatarKey: key })).toBe(
		'/orgs/acme/avatar/abcdef.png',
	)
	expect(buildOrgAvatarUrl({ slug: 'acme', avatarKey: null })).toBeNull()
	expect(parseOrgAvatarCacheKey('user-avatars/person/abcdef.png')).toBeNull()
})
