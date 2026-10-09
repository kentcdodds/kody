import { type Handle, css } from 'remix/component'
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
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import { readRouterPathname } from '#client/router-location.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { on } from '#client/event-mixin.ts'
import {
	defaultProfilePackageSortDirection,
	readProfilePackageFiltersFromHref,
} from '#universal/profile-search.ts'
import { ProfileContent } from '#universal/profile-content.tsx'
import { readAppSession } from '#client/app-session-context.tsx'
import {
	renderOrgIdentity,
	renderProfileIdentity,
} from '#client/routes/profile-identity.tsx'
import { renderOrgHomeMain } from '#client/routes/org-home.tsx'
import {
	orgIdentity,
	orgRoleLabel,
	parseOrgResourcePath,
} from '#universal/org-pages.ts'
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

/**
 * Cache key for the loaded shell and list. The workspace list and the public
 * profile under the same handle are different data.
 */
function getCurrentLoadKey(handle: Handle) {
	const pathname = readRouterPathname(handle)
	const name = getProfileUsernameFromPathname(pathname)
	if (!name) return null
	return isWorkspaceRepositoriesPath(pathname) ? `${name}/packages` : name
}

/** `/@slug/packages`: the workspace Repositories page, not a public profile. */
function isWorkspaceRepositoriesPath(pathname: string) {
	return parseOrgResourcePath(pathname)?.section === 'packages'
}

/**
 * Workspace lists go through the organization gate the document route uses;
 * `key` is the URL handle (an org slug there, a username on a profile).
 */
function profileDataHref(
	pathname: string,
	key: string,
	searchParams: URLSearchParams,
) {
	return isWorkspaceRepositoriesPath(pathname)
		? routes.orgPackagesApi.href({ orgSlug: key }, { searchParams })
		: routes.profileApi.href({ username: key }, { searchParams })
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
		profileDataHref(url.pathname, username, url.searchParams),
		{
			headers: { Accept: 'application/json' },
			credentials: 'include',
			signal,
		},
	)
	if (response.status === 401) return routeLoaderRedirect('/login')
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
	let shellLoadedFor: string | null = null
	let listLoadedFor: string | null = null
	let shellRequestedFor: string | null = null
	let shellLoadRequestId = 0

	async function loadShell() {
		const username = getCurrentUsername(handle)
		const loadKey = getCurrentLoadKey(handle)
		if (!username || !loadKey) return

		const requestId = ++shellLoadRequestId
		if (shellLoadedFor !== loadKey) {
			shellStatus = 'loading'
			list = null
			listLoadedFor = null
			handle.update()
		}

		try {
			const current = new URL(readCurrentRouterHref(handle), 'http://localhost')
			const response = await fetch(
				profileDataHref(current.pathname, username, current.searchParams),
				{
					headers: { Accept: 'application/json' },
					credentials: 'include',
				},
			)
			if (requestId !== shellLoadRequestId) return
			if (response.status === 404) {
				shell = { ok: false, unavailable: true }
				list = null
				shellLoadedFor = loadKey
				listLoadedFor = null
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
			shellLoadedFor = loadKey
			listLoadedFor = loadKey
			shellStatus = 'ready'
			handle.update()
		} catch {
			if (requestId !== shellLoadRequestId) return
			shellLoadedFor = loadKey
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
		const loadKey = getCurrentLoadKey(handle)
		const currentHref = readCurrentRouterHref(handle)
		const currentPathname = new URL(currentHref, 'http://localhost').pathname
		// `/@slug/packages` is the workspace Repositories page, which supplies
		// its own shell and heading; filter links stay on that page.
		const embedded = isWorkspaceRepositoriesPath(currentPathname)

		if (!username || !loadKey) {
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
				shellLoadedFor = loadKey
				shellStatus = 'ready'
			} else {
				shellLoadedFor = loadKey
				shellStatus = 'ready'
				list = null
				listLoadedFor = null
			}
		}
		const routeList = tryConsumeRouteLoaderData(
			handle,
			'profileList',
			currentHref,
		)
		if (routeList) {
			list = routeList
			listLoadedFor = loadKey
		}

		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && shellLoadedFor !== loadKey
		if (
			(needsStaleRefresh ||
				(shellLoadedFor !== loadKey && shellRequestedFor !== loadKey)) &&
			typeof document !== 'undefined'
		) {
			if (shellLoadedFor !== loadKey) {
				shellStatus = 'loading'
			}
			shellRequestedFor = loadKey
			handle.queueTask(loadShell)
		}

		const showUnavailable =
			shellStatus === 'ready' &&
			shell != null &&
			!shell.ok &&
			shellLoadedFor === loadKey
		const readyShell =
			shell != null && shell.ok && shellLoadedFor === loadKey ? shell : null
		const filters = readProfilePackageFiltersFromHref(currentHref, {
			allowOwnerFilters: readyShell?.isSelf === true,
		})
		const searchQuery = filters.query
		const queryAppliedByLoader = new URL(
			currentHref,
			'http://localhost',
		).searchParams.has('limit')
		const visibleList = embedded
			? listLoadedFor === loadKey
				? list
				: null
			: profileListForUsername(list, listLoadedFor, username)

		if (embedded && showUnavailable) {
			return (
				<p
					mix={css(pageDescriptionCss)}
					role="status"
					data-testid="workspace-repositories-unavailable"
				>
					This workspace's repositories aren't available.
				</p>
			)
		}

		const memberOrg = showUnavailable
			? readAppSession(handle)?.session?.organizations?.find(
					(org) => org.slug === username && !org.personal,
				)
			: undefined
		if (memberOrg) {
			const identity = orgIdentity(memberOrg, {
				displayName: '',
				avatarUrl: null,
			})
			return (
				<section mix={css(pageCss)} data-testid="org-page">
					<div mix={css(layoutCss)}>
						{renderOrgIdentity({
							name: identity.name,
							handle: identity.handle,
							avatarName: identity.avatarName,
							role: orgRoleLabel(memberOrg.role),
						})}
						{renderOrgHomeMain({
							handle: identity.handle,
							collaborator: memberOrg.role === null,
						})}
					</div>
				</section>
			)
		}

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

		const basePath = embedded ? currentPathname : undefined
		const repositoryList = (
			<>
				<form
					method="get"
					action={basePath ?? routes.profile.href({ username })}
					role="search"
					mix={css(searchFormCss)}
				>
					{filters.visibility !== 'all' ? (
						<input type="hidden" name="visibility" value={filters.visibility} />
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
					{filters.dir !== defaultProfilePackageSortDirection(filters.sort) ? (
						<input type="hidden" name="dir" value={filters.dir} />
					) : null}
					<label mix={css(searchFieldCss)}>
						<span mix={css(fieldLabelCss)}>Search repositories</span>
						<ProfileRepositorySearchInput
							username={username}
							basePath={basePath}
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
						basePath={basePath}
					/>
				) : null}
			</>
		)

		if (embedded) {
			return (
				<div mix={css(mainCss)} data-testid="workspace-repositories">
					{repositoryList}
				</div>
			)
		}

		return (
			<section mix={css(pageCss)} data-testid="profile-page">
				<div mix={css(layoutCss)}>
					{readyShell ? renderProfileIdentity(readyShell) : null}

					<div mix={css(mainCss)}>
						<h2 mix={css(packagesHeadingCss)}>Repositories</h2>
						{repositoryList}
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
