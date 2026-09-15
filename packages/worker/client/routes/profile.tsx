import { type Handle, css } from 'remix/ui'
import { routes } from '#universal/routes.ts'
import {
	toProfileListLoaderData,
	toProfileShellLoaderData,
	type ProfileListLoaderData,
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
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { type RouteLoaderResult } from '#client/route-loader.ts'
import { readRouterPathname } from '#client/router-location.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { on } from '#client/event-mixin.ts'
import {
	defaultProfilePackageSortDirection,
	readProfilePackageFiltersFromHref,
} from '#universal/profile-search.ts'
import { ProfileContent } from '#universal/profile-content.tsx'
import { renderProfileIdentity } from '#client/routes/profile-identity.tsx'
import { ProfileRepositorySearchInput } from './profile-search-field.tsx'
import { profileListForUsername } from './profile-list-for-username.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	fieldCss,
	fieldLabelCss,
	getPrimaryButtonCss,
	layoutMaxWidths,
	pageDescriptionCss,
	pageGutter,
} from '#universal/styles/style-primitives.ts'

function getCurrentUsername(handle: Handle) {
	return getProfileUsernameFromPathname(readRouterPathname(handle))
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

	const response = await fetch(
		routes.profileApi.href({ username }, { searchParams: url.searchParams }),
		{
			headers: { Accept: 'application/json' },
			credentials: 'include',
			signal,
		},
	)
	if (response.status === 404) {
		return {
			profileShell: { ok: false, unavailable: true },
		}
	}
	const payload = await readJson<ProfileLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load profile.')
	}

	return {
		profileShell: toProfileShellLoaderData(payload),
		profileList: toProfileListLoaderData(payload),
	}
}

export function ProfileRoute(handle: Handle) {
	let shell: ProfileShellLoaderData | ProfileUnavailableLoaderData | null = null
	let list: ProfileListLoaderData | null = null
	let shellStatus: 'loading' | 'ready' | 'error' = 'loading'
	let shellLoadedForUsername: string | null = null
	let listLoadedForUsername: string | null = null
	let shellRequestedForUsername: string | null = null
	let shellLoadRequestId = 0

	async function loadShell() {
		const username = getCurrentUsername(handle)
		if (!username) return

		const requestId = ++shellLoadRequestId
		if (shellLoadedForUsername !== username) {
			shellStatus = 'loading'
			list = null
			listLoadedForUsername = null
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
				list = null
				shellLoadedForUsername = username
				listLoadedForUsername = null
				shellStatus = 'ready'
				handle.update()
				return
			}
			const payload = await readJson<ProfileLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load profile.')
			}
			shell = toProfileShellLoaderData(payload)
			list = toProfileListLoaderData(payload)
			shellLoadedForUsername = username
			listLoadedForUsername = username
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
		handle.update()
	})

	return () => {
		const username = getCurrentUsername(handle)
		const currentHref = readCurrentRouterHref(handle)

		if (!username) {
			return (
				<section mix={css(pageCss)}>
					<h1 mix={css(unavailableTitleCss)}>This profile isn't available.</h1>
				</section>
			)
		}

		const routeShell = tryConsumeRouteLoaderData(
			handle,
			'profileShell',
			currentHref,
		)
		if (routeShell) {
			shell = routeShell
			if (routeShell.ok) {
				shellLoadedForUsername = username
				shellStatus = 'ready'
			} else {
				shellLoadedForUsername = username
				shellStatus = 'ready'
				list = null
				listLoadedForUsername = null
			}
		}
		const routeList = tryConsumeRouteLoaderData(
			handle,
			'profileList',
			currentHref,
		)
		if (routeList) {
			list = routeList
			listLoadedForUsername = username
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

		const showUnavailable =
			shellStatus === 'ready' &&
			shell != null &&
			!shell.ok &&
			shellLoadedForUsername === username
		const readyShell =
			shell != null && shell.ok && shellLoadedForUsername === username
				? shell
				: null
		const filters = readProfilePackageFiltersFromHref(currentHref, {
			allowOwnerFilters: readyShell?.isSelf === true,
		})
		const searchQuery = filters.query
		const queryAppliedByLoader = new URL(
			currentHref,
			'http://localhost',
		).searchParams.has('limit')
		const visibleList = profileListForUsername(
			list,
			listLoadedForUsername,
			username,
		)

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
						<h2 mix={css(packagesHeadingCss)}>Repositories</h2>
						<form
							method="get"
							action={routes.profile.href({ username })}
							role="search"
							mix={css(searchFormCss)}
						>
							{filters.visibility !== 'all' ? (
								<input
									type="hidden"
									name="visibility"
									value={filters.visibility}
								/>
							) : null}
							{filters.listing !== 'all' ? (
								<input type="hidden" name="listing" value={filters.listing} />
							) : null}
							{filters.hidden !== 'all' ? (
								<input type="hidden" name="hidden" value={filters.hidden} />
							) : null}
							{filters.app !== 'all' ? (
								<input type="hidden" name="app" value={filters.app} />
							) : null}
							{filters.package !== 'all' ? (
								<input type="hidden" name="package" value={filters.package} />
							) : null}
							{filters.sort !== 'updated' ? (
								<input type="hidden" name="sort" value={filters.sort} />
							) : null}
							{filters.dir !==
							defaultProfilePackageSortDirection(filters.sort) ? (
								<input type="hidden" name="dir" value={filters.dir} />
							) : null}
							<label mix={css(searchFieldCss)}>
								<span mix={css(fieldLabelCss)}>Search repositories</span>
								<ProfileRepositorySearchInput
									username={username}
									filters={filters}
								/>
							</label>
							<button
								type="submit"
								mix={css({ ...getPrimaryButtonCss(), alignSelf: 'end' })}
							>
								Search
							</button>
						</form>

						{visibleList ? (
							<ProfileContent
								profile={visibleList.profile}
								packages={visibleList.packages}
								activity={visibleList.activity}
								query={searchQuery || null}
								visibility={filters.visibility}
								listing={filters.listing}
								hidden={filters.hidden}
								app={filters.app}
								package={filters.package}
								sort={filters.sort}
								dir={filters.dir}
								isSelf={readyShell?.isSelf === true}
								queryAppliedByLoader={queryAppliedByLoader}
							/>
						) : null}
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
