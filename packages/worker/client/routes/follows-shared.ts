import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	followCreateLimitPerHour,
	followEventCopy,
	followPauseReasonCopy,
	followPausedRetentionDays,
	normalizeFollowEvents,
	type FollowEvent,
	type FollowSummary,
	type OrgFollowsPostBody,
	type OrgFollowsPostPayload,
	type PackageFollowStatePayload,
} from '#universal/follows.ts'
import { routes } from '#universal/routes.ts'

export const followDeliveryNote = `Deliveries are free. Handlers that run on them use this workspace’s credits. A workspace can start following up to ${followCreateLimitPerHour} new things an hour.`

export const followPausedRetentionNote = `Paused follows are deleted after ${followPausedRetentionDays} days.`

/** "New versions and pushes", for a status line. */
export function describeFollowEvents(events: ReadonlyArray<FollowEvent>) {
	const labels = normalizeFollowEvents(events).map((event) =>
		followEventCopy[event].label.toLowerCase(),
	)
	if (labels.length === 0) return 'nothing'
	const sentence = labels.join(' and ')
	return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`
}

/** Why a paused follow stopped, as one sentence the page can show as-is. */
export function describePausedFollow(
	follow: Pick<FollowSummary, 'status' | 'pausedReason'>,
) {
	if (follow.status !== 'paused') return null
	return `Paused. ${followPauseReasonCopy(follow.pausedReason)}`
}

/**
 * Events the panel offers to toggle and why one is off. Pushes need read
 * access; a run-only grant can see the package but not its source.
 */
export function followEventOptions(
	state: Pick<
		PackageFollowStatePayload,
		'availableEvents' | 'canPush' | 'target'
	>,
) {
	return state.availableEvents.map((event) => ({
		event,
		...followEventCopy[event],
		disabledReason:
			event === 'pushed' && !state.canPush
				? `Pushes need read access to ${state.target.name}. A Use grant includes read; run-only access does not.`
				: null,
	}))
}

/** Events checked when the panel opens for one workspace. */
export function initialFollowEventChoice(
	state: Pick<PackageFollowStatePayload, 'availableEvents' | 'canPush'>,
	follow: FollowSummary | null,
): Array<FollowEvent> {
	if (follow) return normalizeFollowEvents(follow.events)
	return state.availableEvents.filter(
		(event) => event !== 'pushed' || state.canPush,
	)
}

/** Copy for a failed follow change. Rate limits name the workspace's hourly cap. */
export function followPostErrorMessage(
	payload: Extract<OrgFollowsPostPayload, { ok: false }>,
) {
	switch (payload.code) {
		case 'rate_limited':
			return `This workspace has started following ${followCreateLimitPerHour} things in the last hour, which is the limit. Try again in about an hour. Changing events or unfollowing still works.`
		case 'invalid':
		case 'not_found':
		case 'unauthorized':
			return payload.error
		default: {
			const exhaustive: never = payload.code
			throw new Error(`Unhandled follow error code: ${String(exhaustive)}`)
		}
	}
}

export async function postOrgFollow(
	orgSlug: string,
	body: OrgFollowsPostBody,
): Promise<OrgFollowsPostPayload> {
	const response = await fetch(routes.orgFollowsApiPost.href({ orgSlug }), {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
		},
		credentials: 'include',
		body: JSON.stringify(body),
	})
	const payload = await readJson<
		OrgFollowsPostPayload | { ok: false; code?: undefined; error?: string }
	>(response)
	if (payload?.ok) return payload
	if (payload?.code) return payload
	return {
		ok: false,
		code: followPostCodeForStatus(response.status),
		error:
			payload?.error ??
			(response.status === 401
				? 'Sign in to follow.'
				: 'Unable to update this follow.'),
	}
}

/** Org gate failures (not a member, unknown org) carry no follow error code. */
function followPostCodeForStatus(status: number) {
	if (status === 401) return 'unauthorized' as const
	if (status === 404 || status === 403) return 'not_found' as const
	if (status === 429) return 'rate_limited' as const
	return 'invalid' as const
}
