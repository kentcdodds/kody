import { toPublicCommunityActivityItem } from '#app/community-public.ts'
import { type TimelineLoaderData } from '#app/loader-data.ts'
import { getCommunityTimeline } from '#worker/community/social-service.ts'

const defaultTimelineLimit = 50

export async function loadTimelineData(input: {
	env: Env
	userId: string
}): Promise<TimelineLoaderData> {
	const items = await getCommunityTimeline({
		env: input.env,
		userId: input.userId,
		limit: defaultTimelineLimit,
	})
	return { ok: true, items: items.map(toPublicCommunityActivityItem) }
}
