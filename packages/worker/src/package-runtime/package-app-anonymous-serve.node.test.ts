import { expect, test } from 'vitest'
import { parsePersonId } from '@kody-internal/shared/owner-person-ids.ts'
import { refuseUnapprovedAnonymousServe } from './package-app-anonymous-serve.ts'

test('anonymous visitors only run the approved published commit', async () => {
	const outcome = (input: {
		approvedPublishedCommit: string | null | undefined
		publishedCommit: string | null | undefined
	}) => {
		const refusal = refuseUnapprovedAnonymousServe({ visitor: null, ...input })
		return refusal ? refusal.status : 'serve'
	}
	expect([
		outcome({ approvedPublishedCommit: 'abc', publishedCommit: 'abc' }),
		outcome({ approvedPublishedCommit: 'abc', publishedCommit: 'def' }),
		outcome({ approvedPublishedCommit: null, publishedCommit: 'abc' }),
		outcome({ approvedPublishedCommit: undefined, publishedCommit: null }),
		outcome({ approvedPublishedCommit: '', publishedCommit: '' }),
	]).toEqual(['serve', 403, 403, 403, 403])

	const refusal = refuseUnapprovedAnonymousServe({
		visitor: null,
		approvedPublishedCommit: 'abc',
		publishedCommit: 'def',
	})
	expect(refusal?.headers.get('Cache-Control')).toBe('no-store')
	await expect(refusal?.text()).resolves.toBe(
		'This version of the app is waiting for its owner to approve it for public visitors.',
	)
})

test('signed-in visitors are never held to the approved commit', () => {
	const userId = parsePersonId('a'.repeat(64))
	if (!userId) throw new Error('Expected a valid test person id.')
	expect(
		refuseUnapprovedAnonymousServe({
			visitor: { userId, username: 'visitor', role: 'member' },
			approvedPublishedCommit: null,
			publishedCommit: 'def',
		}),
	).toBeNull()
})
