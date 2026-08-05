import { expect, test } from 'vitest'
import { type PublicCommunityActivityItem } from '#app/community-public-types.ts'
import {
	formatTimelineDayLabel,
	formatTimelineEventTime,
	groupTimelineItems,
} from '#app/timeline-display.ts'

function makeItem(
	overrides: Partial<PublicCommunityActivityItem> = {},
): PublicCommunityActivityItem {
	return {
		type: 'listing_published',
		actorUsername: 'kentcdodds',
		actorDisplayName: 'Kent C. Dodds',
		actorAvatarUrl: null,
		listingId: 'listing-1',
		listingName: '@kody/slack',
		listingKodyId: 'kody-1',
		createdAt: '2026-08-04T02:42:47.324Z',
		...overrides,
	}
}

test('groups an empty feed into no days', () => {
	expect(groupTimelineItems([])).toEqual([])
})

test('two events on the same UTC day by different actors become two runs', () => {
	const days = groupTimelineItems([
		makeItem({
			actorUsername: 'kentcdodds',
			createdAt: '2026-08-04T10:00:00Z',
		}),
		makeItem({ actorUsername: 'maciek', createdAt: '2026-08-04T09:00:00Z' }),
	])

	expect(days).toHaveLength(1)
	expect(days[0]?.dayKey).toBe('2026-08-04')
	expect(days[0]?.runs.map((run) => run.actorUsername)).toEqual([
		'kentcdodds',
		'maciek',
	])
	expect(days[0]?.runs.map((run) => run.events.length)).toEqual([1, 1])
})

test('consecutive events by the same actor collapse into one run', () => {
	const days = groupTimelineItems([
		makeItem({ createdAt: '2026-08-04T10:00:00Z', listingName: '@kody/a' }),
		makeItem({ createdAt: '2026-08-04T09:00:00Z', listingName: '@kody/b' }),
		makeItem({ createdAt: '2026-08-04T08:00:00Z', listingName: '@kody/c' }),
	])

	expect(days).toHaveLength(1)
	expect(days[0]?.runs).toHaveLength(1)
	expect(days[0]?.runs[0]?.events.map((event) => event.listingName)).toEqual([
		'@kody/a',
		'@kody/b',
		'@kody/c',
	])
})

test('the same actor split across two days becomes two day groups', () => {
	const days = groupTimelineItems([
		makeItem({ createdAt: '2026-08-04T10:00:00Z' }),
		makeItem({ createdAt: '2026-08-03T10:00:00Z' }),
	])

	expect(days.map((day) => day.dayKey)).toEqual(['2026-08-04', '2026-08-03'])
	expect(days.map((day) => day.runs.length)).toEqual([1, 1])
})

test('an actor returning later in the same day starts a new run', () => {
	const days = groupTimelineItems([
		makeItem({
			actorUsername: 'kentcdodds',
			createdAt: '2026-08-04T12:00:00Z',
		}),
		makeItem({ actorUsername: 'maciek', createdAt: '2026-08-04T11:00:00Z' }),
		makeItem({
			actorUsername: 'kentcdodds',
			createdAt: '2026-08-04T10:00:00Z',
		}),
	])

	expect(days[0]?.runs.map((run) => run.actorUsername)).toEqual([
		'kentcdodds',
		'maciek',
		'kentcdodds',
	])
})

test('events either side of UTC midnight land in the days UTC puts them in', () => {
	const days = groupTimelineItems([
		makeItem({ createdAt: '2026-08-04T00:00:03.919Z' }),
		makeItem({ createdAt: '2026-08-03T23:59:30.996Z' }),
	])

	expect(days.map((day) => day.dayKey)).toEqual(['2026-08-04', '2026-08-03'])
	expect(days.map((day) => day.dayLabel)).toEqual([
		'August 4, 2026',
		'August 3, 2026',
	])
})

test('feed order is preserved, never re-sorted', () => {
	const days = groupTimelineItems([
		makeItem({ createdAt: '2026-07-20T10:00:00Z', listingName: '@kody/old' }),
		makeItem({ createdAt: '2026-08-04T10:00:00Z', listingName: '@kody/new' }),
	])

	expect(days.map((day) => day.dayKey)).toEqual(['2026-07-20', '2026-08-04'])
})

test('formatTimelineDayLabel writes the editorial date in UTC', () => {
	expect(formatTimelineDayLabel('2026-08-04T02:42:47.324Z')).toBe(
		'August 4, 2026',
	)
	// 23:30 UTC is already the next day in some zones — the label must not move.
	expect(formatTimelineDayLabel('2026-08-04T23:30:00.000Z')).toBe(
		'August 4, 2026',
	)
})

test('formatTimelineEventTime writes a zero-padded 24-hour UTC clock', () => {
	expect(formatTimelineEventTime('2026-08-04T02:42:47.324Z')).toBe('02:42')
	expect(formatTimelineEventTime('2026-07-21T00:00:33.045Z')).toBe('00:00')
	expect(formatTimelineEventTime('2026-07-22T23:03:19.665Z')).toBe('23:03')
})
