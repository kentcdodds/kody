import { expect, test } from 'vitest'
import { type PublicCommunityActivityItem } from '#universal/community-public-types.ts'
import {
	formatTimelineDayLabel,
	formatTimelineEventTime,
	groupTimelineItems,
} from '#universal/timeline-display.ts'

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

test('groupTimelineItems buckets by UTC day, collapses consecutive actor runs, and preserves feed order', () => {
	expect(groupTimelineItems([])).toEqual([])

	const sameDayDifferentActors = groupTimelineItems([
		makeItem({
			actorUsername: 'kentcdodds',
			createdAt: '2026-08-04T10:00:00Z',
		}),
		makeItem({ actorUsername: 'maciek', createdAt: '2026-08-04T09:00:00Z' }),
	])
	expect(sameDayDifferentActors).toHaveLength(1)
	expect(sameDayDifferentActors[0]?.dayKey).toBe('2026-08-04')
	expect(
		sameDayDifferentActors[0]?.runs.map((run) => run.actorUsername),
	).toEqual(['kentcdodds', 'maciek'])
	expect(
		sameDayDifferentActors[0]?.runs.map((run) => run.events.length),
	).toEqual([1, 1])

	const consecutiveSameActor = groupTimelineItems([
		makeItem({ createdAt: '2026-08-04T10:00:00Z', listingName: '@kody/a' }),
		makeItem({ createdAt: '2026-08-04T09:00:00Z', listingName: '@kody/b' }),
		makeItem({ createdAt: '2026-08-04T08:00:00Z', listingName: '@kody/c' }),
	])
	expect(consecutiveSameActor).toHaveLength(1)
	expect(consecutiveSameActor[0]?.runs).toHaveLength(1)
	expect(
		consecutiveSameActor[0]?.runs[0]?.events.map((event) => event.listingName),
	).toEqual(['@kody/a', '@kody/b', '@kody/c'])

	const splitAcrossDays = groupTimelineItems([
		makeItem({ createdAt: '2026-08-04T10:00:00Z' }),
		makeItem({ createdAt: '2026-08-03T10:00:00Z' }),
	])
	expect(splitAcrossDays.map((day) => day.dayKey)).toEqual([
		'2026-08-04',
		'2026-08-03',
	])
	expect(splitAcrossDays.map((day) => day.runs.length)).toEqual([1, 1])

	const actorReturnsLater = groupTimelineItems([
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
	expect(actorReturnsLater[0]?.runs.map((run) => run.actorUsername)).toEqual([
		'kentcdodds',
		'maciek',
		'kentcdodds',
	])

	const eitherSideOfMidnight = groupTimelineItems([
		makeItem({ createdAt: '2026-08-04T00:00:03.919Z' }),
		makeItem({ createdAt: '2026-08-03T23:59:30.996Z' }),
	])
	expect(eitherSideOfMidnight.map((day) => day.dayKey)).toEqual([
		'2026-08-04',
		'2026-08-03',
	])
	expect(eitherSideOfMidnight.map((day) => day.dayLabel)).toEqual([
		'August 4, 2026',
		'August 3, 2026',
	])

	// Feed order is preserved, never re-sorted by timestamp.
	const outOfOrderFeed = groupTimelineItems([
		makeItem({ createdAt: '2026-07-20T10:00:00Z', listingName: '@kody/old' }),
		makeItem({ createdAt: '2026-08-04T10:00:00Z', listingName: '@kody/new' }),
	])
	expect(outOfOrderFeed.map((day) => day.dayKey)).toEqual([
		'2026-07-20',
		'2026-08-04',
	])

	expect(formatTimelineDayLabel('2026-08-04T02:42:47.324Z')).toBe(
		'August 4, 2026',
	)
	// 23:30 UTC is already the next day in some zones — the label must not move.
	expect(formatTimelineDayLabel('2026-08-04T23:30:00.000Z')).toBe(
		'August 4, 2026',
	)
	expect(formatTimelineEventTime('2026-08-04T02:42:47.324Z')).toBe('02:42')
	expect(formatTimelineEventTime('2026-07-21T00:00:33.045Z')).toBe('00:00')
	expect(formatTimelineEventTime('2026-07-22T23:03:19.665Z')).toBe('23:03')
})
