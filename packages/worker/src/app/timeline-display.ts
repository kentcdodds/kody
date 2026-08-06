import { type PublicCommunityActivityItem } from '#app/community-public-types.ts'

/**
 * How many events the timeline API returns (`loadTimelineData`). The page
 * says "that is the last of the 50 most recent events" only when the feed
 * actually reached this ceiling, so the number lives here rather than being
 * written twice.
 */
export const timelineEventLimit = 50

export type TimelineRun = {
	actorUsername: string
	actorDisplayName: string
	actorAvatarUrl: string | null
	events: Array<PublicCommunityActivityItem>
}

export type TimelineDay = {
	/** Stable `YYYY-MM-DD` key (UTC) for list keys and heading ids. */
	dayKey: string
	/** Formatted date for the heading's visible text ("August 4, 2026"). */
	dayLabel: string
	runs: Array<TimelineRun>
}

function utcDayKey(iso: string) {
	// Normalized through `toISOString` rather than slicing the input: the API
	// returns UTC today, but an offset timestamp ("…+02:00") would put a
	// substring on the wrong day. Falls back to the raw value for anything
	// unparseable.
	const date = new Date(iso)
	if (Number.isNaN(date.getTime())) return iso
	return date.toISOString().slice(0, 10)
}

/**
 * Groups the timeline feed into days, and each day into runs of consecutive
 * events by the same actor — so eleven pushes in one morning read as one
 * person working rather than eleven stamped copies of their face.
 *
 * Order is preserved exactly as given: the server already returns the feed
 * newest-first, and re-sorting here would be a second, divergent opinion
 * about ordering.
 */
export function groupTimelineItems(
	items: Array<PublicCommunityActivityItem>,
): Array<TimelineDay> {
	const days: Array<TimelineDay> = []

	for (const item of items) {
		const dayKey = utcDayKey(item.createdAt)
		let day = days.at(-1)
		if (!day || day.dayKey !== dayKey) {
			day = {
				dayKey,
				dayLabel: formatTimelineDayLabel(item.createdAt),
				runs: [],
			}
			days.push(day)
		}

		let run = day.runs.at(-1)
		if (!run || run.actorUsername !== item.actorUsername) {
			run = {
				actorUsername: item.actorUsername,
				actorDisplayName: item.actorDisplayName,
				actorAvatarUrl: item.actorAvatarUrl,
				events: [],
			}
			day.runs.push(run)
		}
		run.events.push(item)
	}

	return days
}

/**
 * Fixed locale, format, and time zone (UTC) — the timeline is server-rendered
 * from loader data and then hydrated, so a browser-local day boundary would
 * not merely reword a label: it would regroup the days and restructure the
 * whole feed after hydration. `src/app/blog-display.ts` sets the same
 * precedent for the blog's dates.
 */
export function formatTimelineDayLabel(iso: string) {
	const date = new Date(iso)
	if (Number.isNaN(date.getTime())) return iso
	return date.toLocaleDateString('en-US', {
		timeZone: 'UTC',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
	})
}

/** 24-hour UTC clock ("02:42"), fixed for the same reason as the day label. */
export function formatTimelineEventTime(iso: string) {
	const date = new Date(iso)
	if (Number.isNaN(date.getTime())) return iso
	return date.toLocaleTimeString('en-US', {
		timeZone: 'UTC',
		hour: '2-digit',
		minute: '2-digit',
		// `hourCycle` rather than `hour12: false`: with `en-US` that spelling
		// resolves to the h24 cycle on some ICU builds and renders midnight as
		// "24:00". h23 says the intent — "00:00".
		hourCycle: 'h23',
	})
}
