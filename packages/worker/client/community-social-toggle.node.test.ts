import { expect, test, vi } from 'vitest'
import {
	applyCommunityStarAppearance,
	applyDisplayedCount,
	applyFollowAppearance,
	applyFollowError,
	nextDisplayedCount,
	parseDisplayedCount,
	readDisplayedCount,
	postSocialToggleJson,
} from './community-social-toggle.ts'

test('star and follow toggles flip counts, labels, and fetch outcomes', async () => {
	expect(nextDisplayedCount(5, false, true)).toBe(6)
	expect(nextDisplayedCount(5, true, false)).toBe(4)
	expect(nextDisplayedCount(0, true, false)).toBe(0)
	expect(nextDisplayedCount(3, true, true)).toBe(3)
	expect(nextDisplayedCount(3, false, false)).toBe(3)

	expect(parseDisplayedCount('12')).toBe(12)
	expect(parseDisplayedCount('1,234')).toBe(1234)
	expect(parseDisplayedCount(' 8 ')).toBe(8)
	expect(parseDisplayedCount('')).toBe(0)
	expect(parseDisplayedCount('abc')).toBe(0)

	const countEl = { textContent: '4' }
	expect(readDisplayedCount(countEl as never)).toBe(4)
	applyDisplayedCount(countEl as never, 5)
	expect(countEl.textContent).toBe('5')
	expect(readDisplayedCount(null)).toBe(0)
	applyDisplayedCount(null, 9)

	const starLabel = { textContent: 'Star @kody/notes' }
	const starButton = {
		dataset: { starred: 'false', listingName: '@kody/notes' },
		title: 'Star',
		querySelector(selector: string) {
			return selector === '[data-community-star-label]' ? starLabel : null
		},
	}
	applyCommunityStarAppearance(starButton as never, true)
	expect(starButton.dataset.starred).toBe('true')
	expect(starButton.title).toBe('Unstar')
	expect(starLabel.textContent).toBe('Unstar @kody/notes')

	const followLabel = { textContent: 'Follow @kody' }
	const followInput = { value: 'true' }
	const form = {
		querySelector(selector: string) {
			return selector === 'input[name="follow"]' ? followInput : null
		},
	}
	const followButton = {
		dataset: { following: 'false', followUsername: 'kody' },
		title: 'Follow',
		querySelector(selector: string) {
			return selector === '[data-community-follow-label]' ? followLabel : null
		},
		closest(selector: string) {
			return selector === 'form' ? form : null
		},
	}
	applyFollowAppearance(followButton as never, true)
	expect(followButton.dataset.following).toBe('true')
	expect(followButton.title).toBe('Unfollow')
	expect(followLabel.textContent).toBe('Unfollow @kody')
	expect(followInput.value).toBe('false')

	const errorEl = {
		textContent: '',
		removeAttribute: vi.fn(),
		setAttribute: vi.fn(),
	}
	applyFollowError(errorEl as never, 'Unable to follow.')
	expect(errorEl.textContent).toBe('Unable to follow.')
	expect(errorEl.removeAttribute).toHaveBeenCalledWith('hidden')
	applyFollowError(errorEl as never, null)
	expect(errorEl.textContent).toBe('')
	expect(errorEl.setAttribute).toHaveBeenCalledWith('hidden', '')

	const fetchMock = vi.fn()
	vi.stubGlobal('fetch', fetchMock)
	try {
		fetchMock.mockResolvedValueOnce({
			status: 401,
			ok: false,
			json: async () => ({ ok: false, error: 'Unauthorized.' }),
		})
		await expect(
			postSocialToggleJson('/follow.json', { follow: true }, 'fallback'),
		).resolves.toEqual({ status: 'unauthorized' })

		fetchMock.mockResolvedValueOnce({
			status: 400,
			ok: false,
			json: async () => ({ ok: false, error: 'You cannot follow yourself.' }),
		})
		await expect(
			postSocialToggleJson('/follow.json', { follow: true }, 'fallback'),
		).resolves.toEqual({
			status: 'error',
			message: 'You cannot follow yourself.',
		})

		fetchMock.mockResolvedValueOnce({
			status: 200,
			ok: true,
			json: async () => ({ ok: true, following: true }),
		})
		await expect(
			postSocialToggleJson('/follow.json', { follow: true }, 'fallback'),
		).resolves.toEqual({
			status: 'ok',
			payload: { ok: true, following: true },
		})
	} finally {
		vi.unstubAllGlobals()
	}
})
