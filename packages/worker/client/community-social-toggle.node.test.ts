import { expect, test, vi } from 'vitest'
import {
	applyCommunityStarAppearance,
	applyDisplayedCount,
	applyFollowAppearance,
	applyFollowError,
	communityStarCopy,
	nextDisplayedCount,
	parseDisplayedCount,
	profileFollowCopy,
	readDisplayedCount,
	postSocialToggleJson,
	readFollowButtonFromEvent,
} from './community-social-toggle.ts'

test('nextDisplayedCount increments, decrements, and clamps at zero', () => {
	expect(nextDisplayedCount(5, false, true)).toBe(6)
	expect(nextDisplayedCount(5, true, false)).toBe(4)
	expect(nextDisplayedCount(0, true, false)).toBe(0)
	expect(nextDisplayedCount(3, true, true)).toBe(3)
	expect(nextDisplayedCount(3, false, false)).toBe(3)
})

test('parseDisplayedCount reads plain and grouped integers', () => {
	expect(parseDisplayedCount('12')).toBe(12)
	expect(parseDisplayedCount('1,234')).toBe(1234)
	expect(parseDisplayedCount(' 8 ')).toBe(8)
	expect(parseDisplayedCount('')).toBe(0)
	expect(parseDisplayedCount('abc')).toBe(0)
})

test('star and follow copy match the SSR control labels', () => {
	expect(communityStarCopy(false, '@kody/notes')).toEqual({
		title: 'Star',
		label: 'Star @kody/notes',
	})
	expect(communityStarCopy(true, '@kody/notes')).toEqual({
		title: 'Unstar',
		label: 'Unstar @kody/notes',
	})
	expect(profileFollowCopy(false, 'kody')).toEqual({
		title: 'Follow',
		label: 'Follow @kody',
	})
	expect(profileFollowCopy(true, 'kody')).toEqual({
		title: 'Unfollow',
		label: 'Unfollow @kody',
	})
})

test('applyCommunityStarAppearance flips starred attrs, title, and label', () => {
	const label = { textContent: 'Star @kody/notes' }
	const button = {
		dataset: { starred: 'false', listingName: '@kody/notes' },
		title: 'Star',
		querySelector(selector: string) {
			return selector === '[data-community-star-label]' ? label : null
		},
	}

	applyCommunityStarAppearance(button as never, true)

	expect(button.dataset.starred).toBe('true')
	expect(button.title).toBe('Unstar')
	expect(label.textContent).toBe('Unstar @kody/notes')
})

test('applyFollowAppearance flips following attrs, label, and hidden input', () => {
	const label = { textContent: 'Follow @kody' }
	const followInput = { value: 'true' }
	const form = {
		querySelector(selector: string) {
			return selector === 'input[name="follow"]' ? followInput : null
		},
	}
	const button = {
		dataset: { following: 'false', followUsername: 'kody' },
		title: 'Follow',
		querySelector(selector: string) {
			return selector === '[data-community-follow-label]' ? label : null
		},
		closest(selector: string) {
			return selector === 'form' ? form : null
		},
	}

	applyFollowAppearance(button as never, true)

	expect(button.dataset.following).toBe('true')
	expect(button.title).toBe('Unfollow')
	expect(label.textContent).toBe('Unfollow @kody')
	expect(followInput.value).toBe('false')
})

test('applyFollowError shows and hides the follow alert', () => {
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
})

test('readDisplayedCount and applyDisplayedCount round-trip on an element', () => {
	const countEl = { textContent: '4' }
	expect(readDisplayedCount(countEl as never)).toBe(4)
	applyDisplayedCount(countEl as never, 5)
	expect(countEl.textContent).toBe('5')
	expect(readDisplayedCount(null)).toBe(0)
	applyDisplayedCount(null, 9)
})

test('postSocialToggleJson maps 401, payload errors, and success', async () => {
	const fetchMock = vi.fn()
	vi.stubGlobal('fetch', fetchMock)

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

	vi.unstubAllGlobals()
})

test('readFollowButtonFromEvent ignores non-element targets', () => {
	expect(
		readFollowButtonFromEvent({
			type: 'click',
			target: null,
		} as never),
	).toBeNull()
})
