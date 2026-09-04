import { Frame, type Handle, css } from 'remix/ui'
import { routes } from '#universal/routes.ts'
import { PROFILE_TARGET } from '#universal/profile-frame-constants.ts'
import {
	toProfileShellLoaderData,
	type ProfileLoaderData,
	type ProfileShellLoaderData,
	type ProfileUnavailableLoaderData,
} from '#universal/loader-data.ts'
import {
	getProfileUsernameFromPathname,
	isProfilePathname,
} from '#universal/profile-path.ts'
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
import { on } from '#client/event-mixin.ts'
import { readProfileSearchQueryFromHref } from '#client/routes/profile-search.ts'
import { renderProfileIdentity } from '#client/routes/profile-identity.tsx'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	fieldCss,
	fieldLabelCss,
	getPrimaryButtonCss,
	inputCss,
	layoutMaxWidths,
	pageDescriptionCss,
	pageGutter,
} from '#universal/styles/style-primitives.ts'

function getCurrentUsername(handle: Handle) {
	return getProfileUsernameFromPathname(readRouterPathname(handle))
}

function buildProfileFrameSrc(href: string) {
	const url = new URL(href, 'http://localhost')
	return `${url.pathname}${url.search}`
}

export async function profileRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const username = getProfileUsernameFromPathname(url.pathname)
	if (!username) {
		return {
			profileShell: { ok: false, unavailable: true },
		}
	}

	const frameSrc = buildProfileFrameSrc(`${url.pathname}${url.search}`)
	const shellPromise = fetch(
		routes.profileApi.href({ username }, { searchParams: url.searchParams }),
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
		profileShell: toProfileShellLoaderData(payload),
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
				.searchParams
			const response = await fetch(
				routes.profileApi.href({ username }, { searchParams: search }),
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
			shell = toProfileShellLoaderData(payload)
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
		if (!isProfilePathname(new URL(href, 'http://localhost').pathname)) return

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
					<h1 mix={css(unavailableTitleCss)}>This profile isn't available.</h1>
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
			shellStatus === 'ready' &&
			shell != null &&
			!shell.ok &&
			shellLoadedForUsername === username
		const readyShell =
			shell != null && shell.ok && shellLoadedForUsername === username
				? shell
				: null

		if (showUnavailable) {
			return (
				<section mix={css(pageCss)} data-testid="profile-unavailable">
					<h1 mix={css(unavailableTitleCss)}>This profile isn't available.</h1>
				</section>
			)
		}

		if (shellStatus === 'error') {
			return (
				<section mix={css(pageCss)} data-testid="profile-load-error">
					<p mix={css(pageDescriptionCss)} role="status">
						Unable to load this profile.
					</p>
					<button
						type="button"
						mix={[
							css({ ...getPrimaryButtonCss(), width: 'fit-content' }),
							on('click', () => {
								window.location.reload()
							}),
						]}
					>
						Try again
					</button>
				</section>
			)
		}

		return (
			<section mix={css(pageCss)} data-testid="profile-page">
				<div mix={css(layoutCss)}>
					{readyShell ? renderProfileIdentity(readyShell) : null}

					<div mix={css(mainCss)}>
						<h2 mix={css(packagesHeadingCss)}>Packages</h2>
						<form
							method="get"
							action={routes.profile.href({ username })}
							role="search"
							data-rmx-target={PROFILE_TARGET}
							data-rmx-history="push"
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
					</div>
				</div>
			</section>
		)
	}
}

const pageCss = {
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	width: '100%',
	boxSizing: 'border-box' as const,
	padding: `clamp(2rem, 5vw, 3.5rem) ${pageGutter} clamp(4rem, 8vw, 6.5rem)`,
}

const layoutCss = {
	display: 'grid',
	gap: 'clamp(1.75rem, 4vw, 3rem)',
	alignItems: 'start',
	'@media (min-width: 821px)': {
		gridTemplateColumns: '17.5rem minmax(0, 1fr)',
		gap: '2.75rem',
	},
}

const mainCss = {
	display: 'grid',
	gap: spacing.lg,
	minWidth: 0,
}

const packagesHeadingCss = {
	margin: 0,
	fontFamily: typography.fontFamilyDisplay,
	fontSize: 'clamp(1.35rem, 2.4vw, 1.7rem)',
	fontWeight: 720,
	letterSpacing: '-0.018em',
	color: colors.text,
}

const unavailableTitleCss = {
	margin: 0,
	fontSize: typography.fontSize['2xl'],
	fontWeight: typography.fontWeight.semibold,
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
