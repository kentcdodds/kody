// remix-skill: owner settings for a package (`/@user/name/settings`).
import { type Handle, css } from 'remix/component'
import { createMatcher } from 'remix/route-pattern/match'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import {
	createRouteData,
	renderRoutePendingStatus,
	routeDataRedirect,
} from '#client/route-data.tsx'
import { readRouterPathname } from '#client/router-location.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { NotFoundPage } from '#client/not-found-page.tsx'
import { PackageNoAccessPage } from '#client/package-no-access-page.tsx'
import { resolvePackageListIconUrl } from '#universal/identity-icon-urls.ts'
import { type AccountPackageDetail } from '#universal/loader-data.ts'
import {
	fallbackDefaultBranchName,
	getPackageTreeHref,
} from '#universal/package-files.ts'
import { renderPackageRepoChrome } from '#universal/package-repo-nav.tsx'
import {
	type PackageRepoActions,
	renderPackageRepoActions,
} from '#universal/package-title-actions.tsx'
import { routes } from '#universal/routes.ts'
import {
	type CommunityDetailApiPayload,
	type CommunityPackageMovedPayload,
	type CommunityPackageNoAccessPayload,
	type PackageSettingsShell,
	consumePackageSettingsShell,
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
import { createPackageWebhooksController } from './package-webhook-settings.tsx'

const settingsMatcher = createMatcher(routes.communityPackageSettings.pattern)

export function PackageSettingsRoute(handle: Handle) {
	let ownerPackage: AccountPackageDetail | null = null
	let username = ''
	let kodyId = ''
	let isPrivate = false
	let listingId: string | null = null
	let defaultBranch: string | null = null
	let ownerProfilePublic = true
	let viewerCanPublish = false
	let viewerCanManageAccess = false
	let viewerCanDelete = false
	let viewerCanAdoptCommunityFork = false
	let repoActions: PackageRepoActions | null = null
	let ownerDetailsMessage: string | null = null
	/** Payload last applied to the closure state above. */
	let appliedShell: PackageSettingsShell | null = null
	const lockInFlight = new Map<string, string | null>()
	const webhooks = createPackageWebhooksController(handle)
	const settingsData = createRouteData<
		'communityDetailShell',
		PackageSettingsShell
	>({
		consume: consumePackageSettingsShell,
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
				| CommunityDetailApiPayload
				| CommunityPackageMovedPayload
				| CommunityPackageNoAccessPayload
			>(response)
			if (response.status === 401) return { kind: 'unauthorized' }
			if (
				response.status === 403 &&
				payload &&
				!payload.ok &&
				'noAccess' in payload &&
				payload.noAccess
			) {
				return {
					kind: 'no-access',
					username: payload.username,
					kodyId: payload.kodyId,
					packageName: payload.packageName,
					viewerUsername: payload.viewerUsername,
				}
			}
			if (response.status === 404) {
				const movedTo =
					payload && !payload.ok && 'redirectTo' in payload
						? payload.redirectTo
						: null
				if (movedTo) {
					return routeDataRedirect(
						packageMoveDestination(ref.pathname, movedTo),
					)
				}
				return { kind: 'not-found' }
			}
			if (
				!response.ok ||
				!payload?.ok ||
				!payload.ownerPackage ||
				!payload.viewerCanManage
			) {
				return { kind: 'not-found' }
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
				listingId: payload.listing?.id ?? null,
				defaultBranch: payload.listing?.defaultBranch ?? null,
				ownerProfilePublic: payload.ownerProfilePublic,
				viewerCanManageAccess: payload.viewerCanManageAccess === true,
				viewerCanPublish: payload.viewerCanPublish === true,
				viewerCanDelete: payload.viewerCanDelete === true,
				viewerCanAdoptCommunityFork:
					payload.viewerCanAdoptCommunityFork === true,
				repoActions: payload.repoActions ?? null,
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

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const pathname = readRouterPathname(handle)
		const ref = getPackageSettingsPageRef(pathname)
		const urlParams = settingsMatcher.match(
			new URL(pathname, 'http://localhost'),
		)?.params

		if (!ref) {
			return <NotFoundPage />
		}

		const snapshot = settingsData.read(handle, currentHref)
		if (snapshot.data && snapshot.data !== appliedShell) {
			appliedShell = snapshot.data
			switch (snapshot.data.kind) {
				case 'owner':
					ownerPackage = snapshot.data.ownerPackage
					username = snapshot.data.username
					kodyId = snapshot.data.kodyId
					isPrivate = snapshot.data.isPrivate
					listingId = snapshot.data.listingId
					defaultBranch = snapshot.data.defaultBranch
					if (snapshot.data.ownerProfilePublic !== undefined) {
						ownerProfilePublic = snapshot.data.ownerProfilePublic
					}
					viewerCanPublish = snapshot.data.viewerCanPublish
					viewerCanManageAccess = snapshot.data.viewerCanManageAccess
					viewerCanDelete = snapshot.data.viewerCanDelete
					viewerCanAdoptCommunityFork =
						snapshot.data.viewerCanAdoptCommunityFork
					repoActions = snapshot.data.repoActions
					ownerDetailsMessage = null
					break
				case 'unauthorized':
				case 'not-found':
				case 'no-access':
					break
				default: {
					const exhaustive: never = snapshot.data
					throw new Error(`Unhandled settings shell: ${String(exhaustive)}`)
				}
			}
		}

		if (snapshot.data?.kind === 'unauthorized' && !snapshot.stale) {
			return renderMissingListing(
				'Unauthorized',
				'You are not allowed to view this page.',
			)
		}
		if (snapshot.data?.kind === 'no-access' && !snapshot.stale) {
			return (
				<PackageNoAccessPage
					username={snapshot.data.username}
					kodyId={snapshot.data.kodyId}
					packageName={snapshot.data.packageName}
					viewerUsername={snapshot.data.viewerUsername}
				/>
			)
		}
		if (
			(snapshot.data?.kind === 'not-found' && !snapshot.stale) ||
			snapshot.kind === 'not-found'
		) {
			return <NotFoundPage />
		}

		const pending = snapshot.kind === 'pending'
		// The previous package's settings (`snapshot.stale`) stay on screen
		// while a fallback fetch runs; the loading copy is for the cold path.
		const showReady = snapshot.data?.kind === 'owner'
		if (showReady && username && kodyId && typeof document !== 'undefined') {
			handle.queueTask(() => webhooks.ensureLoaded({ username, kodyId }))
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
							isListed: ownerPackage?.hasCommunityListing === true,
							viewerIsOwner: true,
							viewerCanManage: true,
							viewerCanManageAccess,
							active: 'settings',
							filesHref: getPackageTreeHref({
								username: chromeUsername,
								kodyId: chromeKodyId,
								listingId,
								ref: defaultBranch || fallbackDefaultBranchName,
							}),
							description: ownerPackage?.description ?? '',
							ownerProfilePublic,
							iconUrl: resolvePackageListIconUrl({
								username: chromeUsername,
								kodyId: chromeKodyId,
								listingId,
								listingIconCommit: null,
								publishedCommit: ownerPackage?.publishedCommit ?? null,
							}),
							iconName: ownerPackage?.kodyId ?? chromeKodyId,
							actions: renderPackageRepoActions(repoActions),
						})
					: null}
				{renderShellStatus(statusMessage)}
				{showReady && ownerPackage
					? renderOwnerPackageSection({
							ownerUsername: username,
							ownerPackage,
							lockInFlight: lockInFlight.has(ownerPackage.id),
							ownerDetailsMessage,
							viewerCanPublish,
							viewerCanDelete,
							viewerCanAdoptCommunityFork,
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
					? webhooks.render({ username, kodyId })
					: null}
			</article>
		)
	}
}
