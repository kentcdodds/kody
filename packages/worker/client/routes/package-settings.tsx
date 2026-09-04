// remix-skill: owner settings for a package (`/@user/name/settings`).
import { type Handle, css } from 'remix/ui'
import { createMatcher } from 'remix/route-pattern/match'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { readRouterPathname } from '#client/router-location.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	type AccountPackageDetail,
	type AppLoaderData,
} from '#universal/loader-data.ts'
import { renderPackageRepoChrome } from '#universal/package-repo-nav.tsx'
import { routes } from '#universal/routes.ts'
import {
	type CommunityDetailApiPayload,
	type CommunityPackageMovedPayload,
	getPackageSettingsPageRef,
	packageMoveDestination,
	postPackageLock,
	rememberListingId,
} from './community-detail-shared.ts'
import {
	detailArticleCss,
	renderMissingListing,
	renderOwnerPackageSection,
	renderShellStatus,
} from './community-detail-sections.tsx'

const settingsMatcher = createMatcher(routes.communityPackageSettings.pattern)

export function PackageSettingsRoute(handle: Handle) {
	let ownerPackage: AccountPackageDetail | null = null
	let username = ''
	let kodyId = ''
	let isPrivate = false
	let ownerProfilePublic = true
	let ownerDetailsMessage: string | null = null
	let shellStatus: 'loading' | 'ready' | 'error' | 'missing' = 'loading'
	let shellLoadRequestId = 0
	let shellLoadedForPathname: string | null = null
	let shellRequestedForPathname: string | null = null
	let shellUnauthorized = false
	const lockInFlight = new Map<string, string | null>()

	function applyOwnerPackageLock(packageId: string, lockedAt: string | null) {
		if (ownerPackage?.id === packageId) {
			ownerPackage = { ...ownerPackage, lockedAt }
		}
	}

	async function togglePackageLock() {
		if (!ownerPackage || lockInFlight.has(ownerPackage.id)) return
		const packageId = ownerPackage.id
		const previousLockedAt = ownerPackage.lockedAt
		const nextLocked = !(
			typeof previousLockedAt === 'string' && previousLockedAt.trim().length > 0
		)
		const nextLockedAt = nextLocked ? new Date().toISOString() : null
		lockInFlight.set(packageId, nextLockedAt)
		ownerDetailsMessage = null
		applyOwnerPackageLock(packageId, nextLockedAt)
		handle.update()

		const result = await postPackageLock(packageId, nextLocked)
		lockInFlight.delete(packageId)
		if (result.status === 'unauthorized') {
			window.location.assign('/login')
			handle.update()
			return
		}
		if (result.status === 'error') {
			applyOwnerPackageLock(packageId, previousLockedAt)
			if (ownerPackage?.id === packageId) {
				ownerDetailsMessage = result.message
			}
			handle.update()
			return
		}
		applyOwnerPackageLock(packageId, result.lockedAt ?? nextLockedAt)
		if (result.selectedPackage?.id === packageId) {
			ownerPackage = result.selectedPackage
		}
		handle.update()
	}

	async function loadSettingsShell() {
		const ref = getPackageSettingsPageRef(readRouterPathname(handle))
		if (!ref) return

		const requestId = ++shellLoadRequestId
		if (shellLoadedForPathname !== ref.pathname) {
			shellStatus = 'loading'
			handle.update()
		}

		try {
			const response = await fetch(ref.detailApiHref, {
				headers: { Accept: 'application/json' },
			})
			if (requestId !== shellLoadRequestId) return
			const payload = await readJson<
				CommunityDetailApiPayload | CommunityPackageMovedPayload
			>(response)
			if (response.status === 401) {
				shellLoadedForPathname = ref.pathname
				shellUnauthorized = true
				shellStatus = 'ready'
				handle.update()
				return
			}
			if (response.status === 404) {
				const movedTo = payload && !payload.ok ? payload.redirectTo : null
				if (movedTo) {
					window.location.assign(packageMoveDestination(ref.pathname, movedTo))
					return
				}
				shellLoadedForPathname = ref.pathname
				shellStatus = 'missing'
				handle.update()
				return
			}
			if (
				!response.ok ||
				!payload?.ok ||
				!payload.ownerPackage ||
				!payload.viewerIsOwner
			) {
				shellLoadedForPathname = ref.pathname
				shellStatus = 'missing'
				handle.update()
				return
			}
			if (payload.listing) {
				rememberListingId(ref.pathname, payload.listing.id)
			}
			ownerPackage = payload.ownerPackage
			username = payload.username
			kodyId = payload.kodyId || payload.ownerPackage.kodyId
			isPrivate = payload.isPrivate ?? payload.ownerPackage.isPrivate
			ownerProfilePublic = payload.ownerProfilePublic
			ownerDetailsMessage = null
			shellUnauthorized = false
			shellLoadedForPathname = ref.pathname
			shellStatus = 'ready'
			handle.update()
		} catch {
			if (requestId !== shellLoadRequestId) return
			shellLoadedForPathname = ref.pathname
			shellStatus = 'error'
			handle.update()
		}
	}

	function applyRouteShellData(
		routeData: AppLoaderData['communityDetailShell'],
		pathname: string,
	) {
		if (!routeData) return false
		if (!routeData.ok) {
			shellUnauthorized = true
			shellLoadedForPathname = pathname
			shellStatus = 'ready'
			return true
		}
		if (!routeData.ownerPackage || !routeData.viewerIsOwner) {
			shellLoadedForPathname = pathname
			shellStatus = 'missing'
			return true
		}
		ownerPackage = routeData.ownerPackage
		username = routeData.username
		kodyId = routeData.kodyId || routeData.ownerPackage.kodyId
		isPrivate = routeData.isPrivate
		ownerDetailsMessage = null
		shellUnauthorized = false
		shellLoadedForPathname = pathname
		shellStatus = 'ready'
		return true
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const pathname = readRouterPathname(handle)
		const routeData = tryConsumeRouteLoaderData(
			handle,
			'communityDetailShell',
			currentHref,
		)
		if (routeData?.ok && routeData.listingId) {
			rememberListingId(pathname, routeData.listingId)
		}
		const ref = getPackageSettingsPageRef(pathname)
		const urlParams = settingsMatcher.match(
			new URL(pathname, 'http://localhost'),
		)?.params

		if (
			(routeData && !routeData.ok) ||
			(shellUnauthorized && shellLoadedForPathname === pathname)
		) {
			applyRouteShellData(routeData, pathname)
			return renderMissingListing(
				'Unauthorized',
				'You are not allowed to view this page.',
			)
		}

		if (!ref) {
			return renderMissingListing(
				'Package settings not found',
				'This package is unavailable.',
			)
		}

		const appliedShellData = applyRouteShellData(routeData, pathname)
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedShellData
		if (
			(needsStaleRefresh ||
				(shellLoadedForPathname !== pathname &&
					shellRequestedForPathname !== pathname)) &&
			typeof document !== 'undefined'
		) {
			if (shellLoadedForPathname !== pathname) {
				shellStatus = 'loading'
			}
			shellRequestedForPathname = pathname
			handle.queueTask(loadSettingsShell)
		}

		const shellMatches = shellLoadedForPathname === pathname
		const showReady = shellStatus === 'ready' && shellMatches
		const showError = shellStatus === 'error' && shellMatches
		const showMissing = shellStatus === 'missing' && shellMatches
		if (showMissing) {
			return renderMissingListing('Not Found', 'We could not find that page.')
		}
		const statusMessage = showError
			? 'Unable to load package settings.'
			: showReady
				? ''
				: 'Loading package settings…'

		const chromeUsername = username || urlParams?.username || ''
		const chromeKodyId = kodyId || urlParams?.kodyId || ''

		return (
			<article mix={css(detailArticleCss)} data-testid="package-settings">
				{chromeUsername && chromeKodyId
					? renderPackageRepoChrome({
							username: chromeUsername,
							kodyId: chromeKodyId,
							isPrivate,
							viewerIsOwner: true,
							active: 'settings',
							description: ownerPackage?.description ?? '',
							ownerProfilePublic,
						})
					: null}
				{renderShellStatus(statusMessage)}
				{showReady && ownerPackage
					? renderOwnerPackageSection({
							ownerPackage,
							lockInFlight: lockInFlight.has(ownerPackage.id),
							ownerDetailsMessage,
							onToggleLock: () => void togglePackageLock(),
							onPackagesPayload: (payload) => {
								const selected = payload.selectedPackage
								if (selected && selected.id === ownerPackage?.id) {
									ownerPackage = selected
									isPrivate = selected.isPrivate
									handle.update()
								}
							},
						})
					: null}
			</article>
		)
	}
}
