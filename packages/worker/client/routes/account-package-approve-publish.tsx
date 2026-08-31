import { type Handle, css } from 'remix/ui'
import { routes } from '#universal/routes.ts'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
	IdValue,
	MetadataGrid,
} from './account-management-components.tsx'
import { type AccountPackageApprovePublishLoaderData } from '#universal/loader-data.ts'
import {
	getAccentCalloutCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'

const accountPackagesApiPath = '/account/packages.json'
const approvePublishPathPattern =
	/^\/account\/packages\/([^/]+)\/approve-publish\/?$/

type PageStatus = 'loading' | 'ready' | 'error' | 'promoting'

function isApprovePublishPath(href: string) {
	return approvePublishPathPattern.test(
		new URL(href, 'http://localhost').pathname,
	)
}

function buildApprovePublishApiUrl(href: string) {
	const url = new URL(href, 'http://localhost')
	const match = url.pathname.match(approvePublishPathPattern)
	const packageId = match?.[1] ? decodeURIComponent(match[1]) : ''
	const apiUrl = new URL(
		routes.accountPackageApprovePublishApi.href({ packageId }),
		'http://localhost',
	)
	const commit = url.searchParams.get('commit')?.trim()
	if (commit) apiUrl.searchParams.set('commit', commit)
	return `${apiUrl.pathname}${apiUrl.search}`
}

export async function accountPackageApprovePublishRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const href = `${url.pathname}${url.search}`
	const response = await fetch(buildApprovePublishApiUrl(href), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload =
		await readJson<AccountPackageApprovePublishLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load this publish approval.')
	}
	return { accountPackageApprovePublish: payload }
}

export function AccountPackageApprovePublishRoute(handle: Handle) {
	let status: PageStatus = 'loading'
	let payload: AccountPackageApprovePublishLoaderData | null = null
	let message: string | null = null
	const loadLatch = createRouteLoadLatch()

	async function loadPage(href: string) {
		// Do not call handle.update() before the first await — see blog.tsx.
		try {
			const response = await fetch(buildApprovePublishApiUrl(href), {
				headers: { Accept: 'application/json' },
				credentials: 'include',
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const next =
				await readJson<AccountPackageApprovePublishLoaderData>(response)
			if (!response.ok || !next?.ok) {
				status = 'error'
				message = 'Unable to load this publish approval.'
				loadLatch.markFailed(href)
				handle.update()
				return
			}
			payload = next
			status = 'ready'
			message = null
			loadLatch.markLoaded(href)
			handle.update()
		} catch {
			status = 'error'
			message = 'Unable to load this publish approval.'
			loadLatch.markFailed(href)
			handle.update()
		}
	}

	async function promoteCommit() {
		if (!payload?.pendingCommit) return
		status = 'promoting'
		message = null
		handle.update()
		try {
			const response = await fetch(accountPackagesApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'approve-publish',
					packageId: payload.package.id,
					commit: payload.pendingCommit,
				}),
			})
			const body = await readJson<{ ok?: boolean; error?: string }>(response)
			if (!response.ok || body?.ok === false) {
				status = 'ready'
				message = body?.error ?? 'Could not promote this commit.'
				handle.update()
				return
			}
			window.location.assign(payload.packageHref)
		} catch {
			status = 'ready'
			message = 'Could not promote this commit.'
			handle.update()
		}
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		if (!isApprovePublishPath(currentHref)) {
			return <AccountManagementShell>{null}</AccountManagementShell>
		}

		const routeData = tryConsumeRouteLoaderData(
			handle,
			'accountPackageApprovePublish',
			currentHref,
		)
		const appliedRouteData = Boolean(routeData?.ok)
		if (routeData?.ok) {
			payload = routeData
			status = 'ready'
			message = null
			loadLatch.markLoaded(currentHref)
		}

		const needsStaleRefresh = consumeStaleNavigationData(currentHref)
		const needsLoad = loadLatch.needsLoad({
			currentHref,
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			status = 'loading'
			handle.queueTask(async () => {
				try {
					await loadPage(currentHref)
				} catch {
					loadLatch.markFailed(currentHref)
				}
			})
		}

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Approve package publish"
					description="Review the commit, then promote it to the live published pointer. The package stays locked."
					currentHref={currentHref}
				/>
				{message ? (
					<AccountManagementMessage tone="error">
						{message}
					</AccountManagementMessage>
				) : null}
				{status === 'loading' ? (
					<p mix={css({ margin: 0, color: colors.textMuted })}>Loading…</p>
				) : null}
				{status === 'error' ? (
					<p mix={css({ margin: 0, color: colors.textMuted })}>
						This publish approval could not be loaded.
					</p>
				) : null}
				{payload && (status === 'ready' || status === 'promoting') ? (
					<section
						data-testid="package-approve-publish-card"
						mix={css(getAccentCalloutCss())}
					>
						<div mix={css({ display: 'grid', gap: spacing.xs })}>
							<h2
								mix={css({
									margin: 0,
									fontSize: typography.fontSize.lg,
									fontWeight: typography.fontWeight.semibold,
									color: colors.text,
								})}
							>
								{payload.package.name}
							</h2>
							<p mix={css({ margin: 0, color: colors.textMuted })}>
								{payload.package.lockedAt
									? 'This package is locked. Promoting a commit does not unlock it.'
									: 'This package is not locked. Lock it from the package page if you want later publishes to require approval.'}
							</p>
						</div>
						<MetadataGrid
							items={[
								{
									label: 'Kody id',
									value: (
										<IdValue value={payload.package.kodyId} label="Kody id" />
									),
								},
								{
									label: 'Current published commit',
									value: payload.publishedCommit ? (
										<IdValue
											value={payload.publishedCommit}
											label="published commit"
										/>
									) : (
										'None'
									),
								},
								{
									label: 'Commit to promote',
									value: payload.pendingCommit ? (
										<IdValue
											value={payload.pendingCommit}
											label="pending commit"
										/>
									) : (
										'No unpublished commit'
									),
								},
							]}
						/>
						<div
							mix={css({
								display: 'flex',
								flexWrap: 'wrap',
								gap: spacing.xs,
							})}
						>
							{payload.alreadyPublished || !payload.pendingCommit ? (
								<a
									href={payload.packageHref}
									mix={css({
										...getPillButtonCss({ size: 'sm' }),
										display: 'inline-flex',
										textDecoration: 'none',
									})}
								>
									Back to package
								</a>
							) : (
								<>
									<button
										type="button"
										data-testid="approve-package-publish"
										disabled={status === 'promoting'}
										mix={[
											css(getPillButtonCss({ size: 'sm' })),
											on('click', () => void promoteCommit()),
										]}
									>
										{status === 'promoting'
											? 'Promoting…'
											: 'Promote this commit'}
									</button>
									<a
										href={payload.packageHref}
										mix={css({
											...getGhostButtonCss({ size: 'sm' }),
											display: 'inline-flex',
											textDecoration: 'none',
										})}
									>
										Cancel
									</a>
								</>
							)}
							<a
								href={payload.filesHref}
								mix={css({
									...getGhostButtonCss({ size: 'sm' }),
									display: 'inline-flex',
									textDecoration: 'none',
								})}
							>
								Browse published files
							</a>
						</div>
					</section>
				) : null}
			</AccountManagementShell>
		)
	}
}
