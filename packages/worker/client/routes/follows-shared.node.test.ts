import { afterEach, expect, test, vi } from 'vitest'
import {
	describeFollowEvents,
	describePausedFollow,
	followEventOptions,
	followPostErrorMessage,
	initialFollowEventChoice,
	postOrgFollow,
} from '#client/routes/follows-shared.ts'

afterEach(() => {
	vi.unstubAllGlobals()
})

test('describeFollowEvents reads as a sentence in display order', () => {
	expect(describeFollowEvents(['pushed', 'published'])).toBe(
		'New versions and pushes',
	)
	expect(describeFollowEvents(['pushed'])).toBe('Pushes')
	expect(describeFollowEvents([])).toBe('nothing')
})

test('describePausedFollow names the reason only for paused follows', () => {
	expect(
		describePausedFollow({ status: 'paused', pausedReason: 'access_lost' }),
	).toBe('Paused. Whoever followed it no longer has read access.')
	expect(
		describePausedFollow({ status: 'paused', pausedReason: 'target_missing' }),
	).toMatch(/deleted or moved/)
	expect(
		describePausedFollow({ status: 'active', pausedReason: null }),
	).toBeNull()
})

test('pushes are offered only with read access, with the reason when not', () => {
	const target = { name: '@ada/notes', kind: 'package' as const }
	const gated = followEventOptions({
		availableEvents: ['published', 'pushed'],
		canPush: false,
		target,
	})
	expect(gated.map((option) => [option.event, option.disabledReason])).toEqual([
		['published', null],
		[
			'pushed',
			'Pushes need read access to @ada/notes. A Use grant includes read; run-only access does not.',
		],
	])
	expect(
		followEventOptions({
			availableEvents: ['pushed'],
			canPush: true,
			target: { ...target, kind: 'repo' },
		}).map((option) => option.disabledReason),
	).toEqual([null])
})

test('initialFollowEventChoice keeps an existing choice and defaults to what is allowed', () => {
	expect(
		initialFollowEventChoice(
			{ availableEvents: ['published', 'pushed'], canPush: false },
			null,
		),
	).toEqual(['published'])
	expect(
		initialFollowEventChoice(
			{ availableEvents: ['published', 'pushed'], canPush: true },
			null,
		),
	).toEqual(['published', 'pushed'])
	expect(
		initialFollowEventChoice(
			{ availableEvents: ['published', 'pushed'], canPush: true },
			{
				status: 'active',
				events: ['pushed'],
				pausedAt: null,
				pausedReason: null,
				lastDeliverySkipReason: null,
			},
		),
	).toEqual(['pushed'])
	expect(
		initialFollowEventChoice(
			{ availableEvents: ['published', 'pushed'], canPush: false },
			{
				status: 'active',
				events: ['published', 'pushed'],
				pausedAt: null,
				pausedReason: null,
				lastDeliverySkipReason: null,
			},
		),
	).toEqual(['published'])
	expect(
		initialFollowEventChoice(
			{ availableEvents: ['published', 'pushed'], canPush: false },
			{
				status: 'active',
				events: ['pushed'],
				pausedAt: null,
				pausedReason: null,
				lastDeliverySkipReason: null,
			},
		),
	).toEqual([])
})

test('rate-limit errors name the workspace limit', () => {
	expect(
		followPostErrorMessage({
			ok: false,
			code: 'rate_limited',
			error: 'Follow limit reached for this org.',
		}),
	).toMatch(/30 things in the last hour/)
	expect(
		followPostErrorMessage({ ok: false, code: 'invalid', error: 'Nope.' }),
	).toBe('Nope.')
})

test('postOrgFollow posts to the workspace in the URL and fills in gate failures', async () => {
	const fetchMock = vi.fn(
		async () =>
			new Response(JSON.stringify({ ok: false, error: 'Not a member.' }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' },
			}),
	)
	vi.stubGlobal('fetch', fetchMock)

	const payload = await postOrgFollow('acme', {
		intent: 'unfollow',
		id: 'follow-1',
	})

	expect(fetchMock).toHaveBeenCalledWith(
		'/@acme/-/follows.json',
		expect.objectContaining({
			method: 'POST',
			body: JSON.stringify({ intent: 'unfollow', id: 'follow-1' }),
		}),
	)
	expect(payload).toEqual({
		ok: false,
		code: 'not_found',
		error: 'Not a member.',
	})
})
