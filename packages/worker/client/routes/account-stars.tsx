import { type Handle, css } from 'remix/ui'
import { type AccountStarsLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
} from '#client/routes/account-management-components.tsx'
import { type PublicCommunityListing } from '#universal/community-public-types.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	cardCss,
	descriptionCss,
	getDangerPillCss,
	mutedLinkCss,
} from '#universal/styles/style-primitives.ts'

const accountStarsApiPath = routes.accountStarsApi.href()

function isAccountStarsPath(href: string) {
	return (
		new URL(href, 'http://localhost').pathname === routes.accountStars.href()
	)
}

export async function accountStarsRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(accountStarsApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountStarsLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load starred packages.')
	}
	return { accountStars: payload }
}

export function AccountStarsRoute(handle: Handle) {
	let status: 'loading' | 'ready' | 'error' = 'loading'
	let listings: Array<PublicCommunityListing> = []
	let message: string | null = null
	let busyListingId: string | null = null
	const loadLatch = createRouteLoadLatch()

	async function loadStars() {
		const href = readCurrentRouterHref(handle)
		status = 'loading'
		handle.update()
		try {
			const response = await fetch(accountStarsApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<AccountStarsLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load starred packages.')
			}
			listings = payload.listings
			status = 'ready'
			loadLatch.markLoaded(href)
			handle.update()
		} catch {
			status = 'error'
			loadLatch.markFailed(href)
			handle.update()
		}
	}

	async function unstarListing(listingId: string) {
		if (busyListingId) return
		busyListingId = listingId
		message = null
		handle.update()
		try {
			const response = await fetch(
				routes.communityStarApiPost.href({ listingId }),
				{
					method: 'POST',
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/json',
					},
					credentials: 'include',
					body: JSON.stringify({ starred: false }),
				},
			)
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<{ ok: boolean; error?: string }>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error ?? 'Unable to unstar package.')
			}
			listings = listings.filter((listing) => listing.id !== listingId)
			busyListingId = null
			handle.update()
		} catch (error) {
			busyListingId = null
			message =
				error instanceof Error ? error.message : 'Unable to unstar package.'
			handle.update()
		}
	}

	const dangerButtonCss = getDangerPillCss({ size: 'sm' })

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		if (!isAccountStarsPath(currentHref)) {
			return <AccountManagementShell>{null}</AccountManagementShell>
		}

		const routeData = tryConsumeRouteLoaderData(
			handle,
			'accountStars',
			currentHref,
		)
		const appliedRouteData = Boolean(routeData?.ok)
		if (routeData?.ok) {
			listings = routeData.listings
			status = 'ready'
			loadLatch.markLoaded(currentHref)
		}

		const needsStaleRefresh = consumeStaleNavigationData(currentHref)
		const needsLoad = loadLatch.needsLoad({
			currentHref,
			isLoading: status === 'loading',
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			handle.queueTask(async () => {
				try {
					await loadStars()
					if (status === 'ready') loadLatch.markLoaded(currentHref)
					else loadLatch.markFailed(currentHref)
				} catch {
					loadLatch.markFailed(currentHref)
				}
			})
		}

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Starred packages"
					description="Community packages you have starred."
					currentHref={currentHref}
				/>
				{message ? (
					<AccountManagementMessage tone="error">
						{message}
					</AccountManagementMessage>
				) : null}
				{status === 'loading' ? (
					<p mix={css(descriptionCss)}>Loading starred packages…</p>
				) : null}
				{status === 'error' ? (
					<p mix={css(descriptionCss)} role="status">
						Unable to load starred packages.
					</p>
				) : null}
				{status === 'ready' && listings.length === 0 ? (
					<p mix={css(descriptionCss)} data-testid="account-stars-empty">
						You have not starred any community packages yet.{' '}
						<a href={routes.community.href()} mix={css(mutedLinkCss)}>
							Browse the community
						</a>
					</p>
				) : null}
				{status === 'ready' && listings.length > 0 ? (
					<ul mix={css(listCss)} data-testid="account-stars-list">
						{listings.map((listing) => (
							<li key={listing.id} mix={css(cardCss)}>
								<div mix={css(rowCss)}>
									<div>
										<a
											href={routes.communityDetail.href({
												listingId: listing.id,
											})}
											mix={css(titleLinkCss)}
										>
											{listing.name}
										</a>
										<p mix={css(descriptionCss)}>{listing.description}</p>
									</div>
									<button
										type="button"
										disabled={busyListingId === listing.id}
										mix={[
											on('click', () => void unstarListing(listing.id)),
											css(dangerButtonCss),
										]}
									>
										{busyListingId === listing.id ? 'Removing…' : 'Unstar'}
									</button>
								</div>
							</li>
						))}
					</ul>
				) : null}
			</AccountManagementShell>
		)
	}
}

const listCss = {
	display: 'grid',
	gap: spacing.md,
	margin: 0,
	padding: 0,
	listStyle: 'none',
}

const rowCss = {
	display: 'flex',
	justifyContent: 'space-between',
	alignItems: 'flex-start',
	gap: spacing.md,
	flexWrap: 'wrap' as const,
}

const titleLinkCss = {
	color: colors.primaryText,
	fontWeight: typography.fontWeight.semibold,
	textDecoration: 'none',
	overflowWrap: 'anywhere' as const,
}
