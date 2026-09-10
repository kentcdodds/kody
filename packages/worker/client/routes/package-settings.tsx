// remix-skill: owner settings for a package (`/@user/name/settings`).
import { type Handle, css } from 'remix/ui'
import { createMatcher } from 'remix/route-pattern/match'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import {
	createRouteData,
	renderRoutePendingStatus,
	routeDataRedirect,
} from '#client/route-data.tsx'
import { readRouterPathname } from '#client/router-location.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { type AccountPackageDetail } from '#universal/loader-data.ts'
import { type PackageShareGrantLoaderView } from '#universal/package-share.ts'
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
import {
	loadPackageShareGrants,
	renderPackageShareSettings,
} from './package-share-settings.tsx'
import { postPackageShareAction } from './package-share-client.ts'

const settingsMatcher = createMatcher(routes.communityPackageSettings.pattern)

/** Shell payload for the settings page, normalized from either source. */
type PackageSettingsShell =
	| { kind: 'unauthorized' }
	| {
			kind: 'owner'
			ownerPackage: AccountPackageDetail
			username: string
			kodyId: string
			isPrivate: boolean
			/** Only the detail API reports this; SSR shell data leaves it as is. */
			ownerProfilePublic?: boolean
	  }

export function PackageSettingsRoute(handle: Handle) {
	let ownerPackage: AccountPackageDetail | null = null
	let username = ''
	let kodyId = ''
	let isPrivate = false
	let ownerProfilePublic = true
	let ownerDetailsMessage: string | null = null
	/** Payload last applied to the closure state above. */
	let appliedShell: PackageSettingsShell | null = null
	const lockInFlight = new Map<string, string | null>()
	let shareGrants: Array<PackageShareGrantLoaderView> = []
	let shareInviteUsername = ''
	let shareInviteEmail = ''
	let shareBusy = false
	let shareMessage: string | null = null
	let shareLoadedFor = ''
	const settingsData = createRouteData<
		'communityDetailShell',
		PackageSettingsShell
	>({
		consume(routeHandle, href) {
			const routeData = tryConsumeRouteLoaderData(
				routeHandle,
				'communityDetailShell',
				href,
			)
			if (!routeData) return null
			if (!routeData.ok) return { kind: 'unauthorized' }
			const pathname = new URL(href, 'http://localhost').pathname
			if (routeData.listingId) {
				rememberListingId(pathname, routeData.listingId)
			}
			if (!routeData.ownerPackage || !routeData.viewerIsOwner) return null
			return {
				kind: 'owner',
				ownerPackage: routeData.ownerPackage,
				username: routeData.username,
				kodyId: routeData.kodyId || routeData.ownerPackage.kodyId,
				isPrivate: routeData.isPrivate,
			}
		},
		async load(href, signal) {
			const ref = getPackageSettingsPageRef(
				new URL(href, 'http://localhost').pathname,
			)
			if (!ref) return null
			const response = await fetch(ref.detailApiHref, {
				headers: { Accept: 'application/json' },
				signal,
			})
			const payload = await readJson<
				CommunityDetailApiPayload | CommunityPackageMovedPayload
			>(response)
			if (response.status === 401) return { kind: 'unauthorized' }
			if (response.status === 404) {
				const movedTo = payload && !payload.ok ? payload.redirectTo : null
				if (movedTo) {
					return routeDataRedirect(
						packageMoveDestination(ref.pathname, movedTo),
					)
				}
				return null
			}
			if (
				!response.ok ||
				!payload?.ok ||
				!payload.ownerPackage ||
				!payload.viewerIsOwner
			) {
				return null
			}
			if (payload.listing) {
				rememberListingId(ref.pathname, payload.listing.id)
			}
			return {
				kind: 'owner',
				ownerPackage: payload.ownerPackage,
				username: payload.username,
				kodyId: payload.kodyId || payload.ownerPackage.kodyId,
				isPrivate: payload.isPrivate ?? payload.ownerPackage.isPrivate,
				ownerProfilePublic: payload.ownerProfilePublic,
			}
		},
	})

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

	async function refreshShareGrants(nextUsername: string, nextKodyId: string) {
		const key = `${nextUsername}/${nextKodyId}`
		if (!nextUsername || !nextKodyId || shareLoadedFor === key) return
		shareLoadedFor = key
		shareGrants = await loadPackageShareGrants({
			username: nextUsername,
			kodyId: nextKodyId,
		})
		handle.update()
	}

	async function inviteShare() {
		if (shareBusy || !username || !kodyId) return
		shareBusy = true
		shareMessage = null
		handle.update()
		const result = await postPackageShareAction({
			intent: 'invite',
			ownerUsername: username,
			kodyId,
			username: shareInviteUsername,
			email: shareInviteEmail,
		})
		shareBusy = false
		if (result.status === 'unauthorized') {
			window.location.assign('/login')
			return
		}
		if (result.status === 'error') {
			shareMessage = result.message
			handle.update()
			return
		}
		shareInviteUsername = ''
		shareInviteEmail = ''
		shareLoadedFor = ''
		await refreshShareGrants(username, kodyId)
	}

	async function revokeShare(grantId: string) {
		if (shareBusy || !username || !kodyId) return
		shareBusy = true
		shareMessage = null
		handle.update()
		const result = await postPackageShareAction({
			intent: 'revoke',
			ownerUsername: username,
			kodyId,
			grantId,
		})
		shareBusy = false
		if (result.status === 'unauthorized') {
			window.location.assign('/login')
			return
		}
		if (result.status === 'error') {
			shareMessage = result.message
			handle.update()
			return
		}
		shareLoadedFor = ''
		await refreshShareGrants(username, kodyId)
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const pathname = readRouterPathname(handle)
		const ref = getPackageSettingsPageRef(pathname)
		const urlParams = settingsMatcher.match(
			new URL(pathname, 'http://localhost'),
		)?.params

		if (!ref) {
			return renderMissingListing(
				'Package settings not found',
				'This package is unavailable.',
			)
		}

		const snapshot = settingsData.read(handle, currentHref)
		if (snapshot.data && snapshot.data !== appliedShell) {
			appliedShell = snapshot.data
			if (snapshot.data.kind === 'owner') {
				ownerPackage = snapshot.data.ownerPackage
				username = snapshot.data.username
				kodyId = snapshot.data.kodyId
				isPrivate = snapshot.data.isPrivate
				if (snapshot.data.ownerProfilePublic !== undefined) {
					ownerProfilePublic = snapshot.data.ownerProfilePublic
				}
				ownerDetailsMessage = null
			}
		}

		if (snapshot.data?.kind === 'unauthorized' && !snapshot.stale) {
			return renderMissingListing(
				'Unauthorized',
				'You are not allowed to view this page.',
			)
		}
		if (snapshot.kind === 'not-found') {
			return renderMissingListing('Not Found', 'We could not find that page.')
		}

		const pending = snapshot.kind === 'pending'
		// The previous package's settings (`snapshot.stale`) stay on screen
		// while a fallback fetch runs; the loading copy is for the cold path.
		const showReady = snapshot.data?.kind === 'owner'
		if (
			showReady &&
			username &&
			kodyId &&
			shareLoadedFor !== `${username}/${kodyId}` &&
			typeof document !== 'undefined'
		) {
			handle.queueTask(() => refreshShareGrants(username, kodyId))
		}
		const showError = snapshot.kind === 'error'
		const statusMessage = showError
			? 'Unable to load package settings.'
			: showReady
				? ''
				: 'Loading package settings…'

		const chromeUsername = username || urlParams?.username || ''
		const chromeKodyId = kodyId || urlParams?.kodyId || ''

		return (
			<article
				mix={css(detailArticleCss)}
				data-testid="package-settings"
				aria-busy={pending && showReady ? 'true' : undefined}
			>
				{pending && showReady ? renderRoutePendingStatus() : null}
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
							ownerUsername: username,
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
				{showReady && ownerPackage
					? renderPackageShareSettings({
							username,
							kodyId,
							grants: shareGrants,
							inviteUsername: shareInviteUsername,
							inviteEmail: shareInviteEmail,
							busy: shareBusy,
							message: shareMessage,
							onInviteUsername: (value) => {
								shareInviteUsername = value
								handle.update()
							},
							onInviteEmail: (value) => {
								shareInviteEmail = value
								handle.update()
							},
							onInvite: () => void inviteShare(),
							onRevoke: (grantId) => void revokeShare(grantId),
						})
					: null}
			</article>
		)
	}
}
