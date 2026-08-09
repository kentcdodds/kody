import { Frame, type Handle, css } from 'remix/ui'
import { routes } from '#universal/routes.ts'
import { PROFILE_TARGET } from '#universal/profile-frame-constants.ts'
import {
	type ProfileLoaderData,
	type ProfileShellLoaderData,
	type ProfileUnavailableLoaderData,
} from '#universal/loader-data.ts'
import {
	listenToRouterNavigation,
	readCurrentRouterHref,
} from '#client/client-router.tsx'
import { prefetchFrame } from '#client/frame-prefetch.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { type RouteLoaderResult } from '#client/route-loader.ts'
import { readRouterPathname } from '#client/router-location.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { readProfileSearchQueryFromHref } from '#client/routes/profile-search.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	fieldCss,
	fieldLabelCss,
	getPrimaryButtonCss,
	inputCss,
	layoutMaxWidths,
	mutedLinkCss,
	pageDescriptionCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'

function getUsernameFromPathname(pathname: string) {
	if (!pathname.startsWith('/@')) return null
	const username = decodeURIComponent(pathname.slice(2).replace(/\/$/, ''))
	return username || null
}

function getCurrentUsername(handle: Handle) {
	return getUsernameFromPathname(readRouterPathname(handle))
}

function buildProfileFrameSrc(href: string) {
	const url = new URL(href, 'http://localhost')
	return `${url.pathname}${url.search}`
}

function isProfilePath(href: string) {
	return (
		getUsernameFromPathname(new URL(href, 'http://localhost').pathname) != null
	)
}

export async function profileRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const username = getUsernameFromPathname(url.pathname)
	if (!username) {
		return {
			profileShell: { ok: false, unavailable: true },
		}
	}

	const frameSrc = buildProfileFrameSrc(`${url.pathname}${url.search}`)
	const shellPromise = fetch(
		routes.profileApi.href({ username }) + url.search,
		{
			headers: { Accept: 'application/json' },
			credentials: 'include',
			signal,
		},
	)
	const framePrefetchPromise = prefetchFrame(frameSrc, PROFILE_TARGET, signal)

	const response = await shellPromise
	if (response.status === 404) {
		await framePrefetchPromise.catch(() => {})
		return {
			profileShell: { ok: false, unavailable: true },
		}
	}
	const payload = await readJson<ProfileLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load profile.')
	}

	await framePrefetchPromise

	return {
		profileShell: {
			ok: true,
			username: payload.profile.username,
			displayName: payload.profile.displayName,
			bio: payload.profile.bio,
			isSelf: payload.isSelf,
			loggedIn: payload.loggedIn,
			isFollowing: payload.isFollowing,
			visibility: payload.profile.visibility,
		},
	}
}

export function ProfileRoute(handle: Handle) {
	let shell: ProfileShellLoaderData | ProfileUnavailableLoaderData | null = null
	let shellStatus: 'loading' | 'ready' | 'error' = 'loading'
	let shellLoadedForUsername: string | null = null
	let shellRequestedForUsername: string | null = null
	let shellLoadRequestId = 0

	async function loadShell() {
		const username = getCurrentUsername(handle)
		if (!username) return

		const requestId = ++shellLoadRequestId
		if (shellLoadedForUsername !== username) {
			shellStatus = 'loading'
			handle.update()
		}

		try {
			const search = new URL(readCurrentRouterHref(handle), 'http://localhost')
				.search
			const response = await fetch(
				routes.profileApi.href({ username }) + search,
				{
					headers: { Accept: 'application/json' },
					credentials: 'include',
				},
			)
			if (requestId !== shellLoadRequestId) return
			if (response.status === 404) {
				shell = { ok: false, unavailable: true }
				shellLoadedForUsername = username
				shellStatus = 'ready'
				handle.update()
				return
			}
			const payload = await readJson<ProfileLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load profile.')
			}
			shell = {
				ok: true,
				username: payload.profile.username,
				displayName: payload.profile.displayName,
				bio: payload.profile.bio,
				isSelf: payload.isSelf,
				loggedIn: payload.loggedIn,
				isFollowing: payload.isFollowing,
				visibility: payload.profile.visibility,
			}
			shellLoadedForUsername = username
			shellStatus = 'ready'
			handle.update()
		} catch {
			if (requestId !== shellLoadRequestId) return
			shellLoadedForUsername = username
			shellStatus = 'error'
			handle.update()
		}
	}

	listenToRouterNavigation(handle, () => {
		const href = readCurrentRouterHref(handle)
		if (!isProfilePath(href)) return

		const frame = handle.frames.get(PROFILE_TARGET)
		if (!frame) return

		const nextSrc = buildProfileFrameSrc(href)
		if (frame.src !== nextSrc) {
			frame.src = nextSrc
		}
		void frame.reload()
	})

	return () => {
		const username = getCurrentUsername(handle)
		const currentHref = readCurrentRouterHref(handle)
		const searchQuery = readProfileSearchQueryFromHref(currentHref)

		if (!username) {
			return (
				<section mix={css(pageCss)}>
					<h1 mix={css(titleCss)}>This profile isn't available.</h1>
				</section>
			)
		}

		const routeData = tryConsumeRouteLoaderData(
			handle,
			'profileShell',
			currentHref,
		)
		if (routeData && shellLoadedForUsername !== username) {
			shell = routeData
			shellLoadedForUsername = username
			shellStatus = 'ready'
		}

		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) &&
			shellLoadedForUsername !== username
		if (
			(needsStaleRefresh ||
				(shellLoadedForUsername !== username &&
					shellRequestedForUsername !== username)) &&
			typeof document !== 'undefined'
		) {
			if (shellLoadedForUsername !== username) {
				shellStatus = 'loading'
			}
			shellRequestedForUsername = username
			handle.queueTask(loadShell)
		}

		const frameSrc = buildProfileFrameSrc(currentHref)
		const showUnavailable =
			shellStatus === 'ready' && shell != null && !shell.ok
		const readyShell = shell != null && shell.ok ? shell : null

		if (showUnavailable) {
			return (
				<section mix={css(pageCss)} data-testid="profile-unavailable">
					<h1 mix={css(titleCss)}>This profile isn't available.</h1>
				</section>
			)
		}

		return (
			<section mix={css(pageCss)}>
				{readyShell?.isSelf ? (
					<div mix={css(actionsCss)} data-testid="profile-actions">
						<a href={routes.account.href()} mix={css(mutedLinkCss)}>
							Edit profile
						</a>
						{readyShell.visibility === 'private' ? (
							<span mix={css(badgeCss)}>Private</span>
						) : null}
					</div>
				) : null}

				{shellStatus === 'loading' ? (
					<p mix={css(pageDescriptionCss)}>Loading profile…</p>
				) : null}
				{shellStatus === 'error' ? (
					<p mix={css(pageDescriptionCss)} role="status">
						Unable to load this profile.
					</p>
				) : null}

				<form
					method="get"
					action={routes.profile.href({ username })}
					mix={css(searchFormCss)}
				>
					<label mix={css(searchFieldCss)}>
						<span mix={css(fieldLabelCss)}>Search packages</span>
						<input
							key={searchQuery}
							type="search"
							name="q"
							defaultValue={searchQuery}
							placeholder="Search by name, description, or tags"
							mix={css(inputCss)}
						/>
					</label>
					<button
						type="submit"
						mix={css({ ...getPrimaryButtonCss(), alignSelf: 'end' })}
					>
						Search
					</button>
				</form>

				<Frame name={PROFILE_TARGET} src={frameSrc} />
			</section>
		)
	}
}

const pageCss = {
	...stackedPageCss,
	maxWidth: layoutMaxWidths.extended,
	margin: '0 auto',
	width: '100%',
}

const titleCss = {
	margin: 0,
	fontSize: typography.fontSize['2xl'],
	fontWeight: typography.fontWeight.semibold,
}

const actionsCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.md,
	flexWrap: 'wrap' as const,
}

const badgeCss = {
	fontSize: typography.fontSize.sm,
	color: colors.primaryText,
	fontWeight: typography.fontWeight.medium,
}

const searchFormCss = {
	display: 'flex',
	gap: spacing.md,
	alignItems: 'end',
	flexWrap: 'wrap' as const,
}

const searchFieldCss = {
	...fieldCss,
	flex: '1 1 16rem',
	minWidth: '12rem',
}
