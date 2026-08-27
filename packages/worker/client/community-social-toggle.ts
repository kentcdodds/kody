import { readJson } from '#client/routes/account-approval-shared.ts'
import { routes } from '#universal/routes.ts'

export function nextDisplayedCount(
	current: number,
	wasActive: boolean,
	willBeActive: boolean,
) {
	if (wasActive === willBeActive) return current
	if (willBeActive) return current + 1
	return Math.max(0, current - 1)
}

export function parseDisplayedCount(text: string) {
	const parsed = Number.parseInt(text.replaceAll(',', '').trim(), 10)
	return Number.isFinite(parsed) ? parsed : 0
}

export function communityStarCopy(starred: boolean, listingName: string) {
	return starred
		? { title: 'Unstar', label: `Unstar ${listingName}` }
		: { title: 'Star', label: `Star ${listingName}` }
}

export function profileFollowCopy(following: boolean, username: string) {
	return following
		? { title: 'Unfollow', label: `Unfollow @${username}` }
		: { title: 'Follow', label: `Follow @${username}` }
}

type CountSurface = {
	textContent: string | null
}

type LabelSurface = {
	textContent: string | null
}

type FollowValueInput = {
	value: string
}

type FollowErrorSurface = {
	textContent: string | null
	removeAttribute: (name: string) => void
	setAttribute: (name: string, value: string) => void
}

export type StarToggleButton = {
	dataset: { starred?: string; listingName?: string }
	title: string
	querySelector: (selector: string) => LabelSurface | null
}

export type FollowToggleButton = {
	dataset: { following?: string; followUsername?: string }
	title: string
	querySelector: (selector: string) => LabelSurface | null
	closest: (
		selector: string,
	) => { querySelector: (selector: string) => FollowValueInput | null } | null
}

export function readDisplayedCount(element: CountSurface | null | undefined) {
	if (!element) return 0
	return parseDisplayedCount(element.textContent ?? '')
}

export function applyDisplayedCount(
	element: CountSurface | null | undefined,
	count: number,
) {
	if (!element) return
	element.textContent = String(count)
}

export function findCommunityStarCountElement(from: Element) {
	return from
		.closest('[data-testid="community-detail-frame"]')
		?.querySelector('[data-community-star-count]')
}

export function findProfileFollowerCountElement(from: Element) {
	return from
		.closest('[data-testid="profile-frame"]')
		?.querySelector('[data-community-follower-count]')
}

export function findFollowErrorElement(from: Element) {
	return from
		.closest('[data-community-follow-control]')
		?.querySelector('[data-community-follow-error]')
}

export function applyCommunityStarAppearance(
	button: StarToggleButton | HTMLElement,
	starred: boolean,
) {
	const copy = communityStarCopy(starred, button.dataset.listingName ?? '')
	button.dataset.starred = starred ? 'true' : 'false'
	button.title = copy.title
	const label = button.querySelector('[data-community-star-label]')
	if (label) label.textContent = copy.label
}

export function applyFollowAppearance(
	button: FollowToggleButton | HTMLElement,
	following: boolean,
) {
	const copy = profileFollowCopy(following, button.dataset.followUsername ?? '')
	button.dataset.following = following ? 'true' : 'false'
	button.title = copy.title
	const label = button.querySelector('[data-community-follow-label]')
	if (label) label.textContent = copy.label
	const followInput = button
		.closest('form')
		?.querySelector('input[name="follow"]')
	if (followInput && 'value' in followInput) {
		followInput.value = String(!following)
	}
}

export function applyFollowError(
	errorEl: FollowErrorSurface | null | undefined,
	message: string | null,
) {
	if (!errorEl) return
	errorEl.textContent = message ?? ''
	if (message) {
		errorEl.removeAttribute('hidden')
	} else {
		errorEl.setAttribute('hidden', '')
	}
}

export function readFollowButtonFromEvent(event: Event) {
	const target = event.target
	if (typeof Element === 'undefined' || !(target instanceof Element)) {
		return null
	}
	if (event.type === 'submit' && target instanceof HTMLFormElement) {
		const button = target.querySelector('[data-community-follow]')
		return button instanceof HTMLButtonElement ? button : null
	}
	const button = target.closest('[data-community-follow]')
	return button instanceof HTMLButtonElement ? button : null
}

export type SocialToggleResult<T> =
	| { status: 'ok'; payload: T }
	| { status: 'unauthorized' }
	| { status: 'error'; message: string }

export async function postSocialToggleJson<
	T extends { ok?: boolean; error?: string },
>(
	href: string,
	body: unknown,
	fallbackError: string,
): Promise<SocialToggleResult<T>> {
	const response = await fetch(href, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
		},
		credentials: 'include',
		body: JSON.stringify(body),
	})
	if (response.status === 401) return { status: 'unauthorized' }
	const payload = await readJson<T>(response)
	if (!response.ok || !payload?.ok) {
		return {
			status: 'error',
			message: payload?.error ?? fallbackError,
		}
	}
	return { status: 'ok', payload }
}

export async function submitOptimisticFollow(
	button: HTMLElement,
	isStale: () => boolean,
): Promise<'unauthorized' | 'ok' | 'error'> {
	const username = button.dataset.followUsername
	if (!username) return 'error'

	const previousFollowing = button.dataset.following === 'true'
	const nextFollowing = !previousFollowing
	const errorEl = findFollowErrorElement(button)
	const countEl = findProfileFollowerCountElement(button)
	const previousCount = readDisplayedCount(countEl)

	applyFollowAppearance(button, nextFollowing)
	applyDisplayedCount(
		countEl,
		nextDisplayedCount(previousCount, previousFollowing, nextFollowing),
	)
	applyFollowError(errorEl, null)

	try {
		const result = await postSocialToggleJson<{
			ok: boolean
			following?: boolean
			error?: string
		}>(
			routes.profileFollowApiPost.href({ username }),
			{ follow: nextFollowing },
			'Unable to update follow status.',
		)
		if (result.status === 'unauthorized') return 'unauthorized'
		if (isStale()) return 'ok'
		switch (result.status) {
			case 'ok':
				applyFollowAppearance(button, result.payload.following ?? nextFollowing)
				return 'ok'
			case 'error':
				applyFollowAppearance(button, previousFollowing)
				applyDisplayedCount(countEl, previousCount)
				applyFollowError(errorEl, result.message)
				return 'error'
			default: {
				const exhaustive: never = result
				throw new Error(`Unhandled follow result: ${String(exhaustive)}`)
			}
		}
	} catch (error) {
		if (isStale()) return 'ok'
		applyFollowAppearance(button, previousFollowing)
		applyDisplayedCount(countEl, previousCount)
		applyFollowError(
			errorEl,
			error instanceof Error
				? error.message
				: 'Unable to update follow status.',
		)
		return 'error'
	}
}
