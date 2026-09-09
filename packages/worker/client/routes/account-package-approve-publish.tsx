import { type Handle, css } from 'remix/ui'
import { createMatcher } from 'remix/route-pattern/match'
import { routes } from '#universal/routes.ts'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
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
const approvePublishMatcher = createMatcher(
	routes.communityPackageApprovePublish.pattern,
)

type PageStatus = 'loading' | 'ready' | 'error' | 'promoting'

const loadFailureMessage = 'Unable to load this publish approval.'

function isApprovePublishPath(href: string) {
	return approvePublishMatcher.match(new URL(href, 'http://localhost')) !== null
}

function buildApprovePublishApiUrl(href: string) {
	const url = new URL(href, 'http://localhost')
	const match = approvePublishMatcher.match(url)
	const apiUrl = new URL(
		routes.communityPackageApprovePublishApi.href({
			username: match?.params.username ?? '',
			kodyId: match?.params.kodyId ?? '',
		}),
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
	/** Payload last applied from the route data; also read by `promoteCommit`. */
	let payload: AccountPackageApprovePublishLoaderData | null = null
	let promoting = false
	let message: string | null = null
	let appliedError: Error | null = null
	const approvePublishData = createRouteData({
		key: 'accountPackageApprovePublish',
		async load(href, signal) {
			const response = await fetch(buildApprovePublishApiUrl(href), {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			}).catch(() => null)
			if (!response) throw new Error(loadFailureMessage)
			if (response.status === 401) return routeDataRedirect('/login')
			const next =
				await readJson<AccountPackageApprovePublishLoaderData>(response)
			if (!response.ok || !next?.ok) throw new Error(loadFailureMessage)
			return next
		},
	})

	async function promoteCommit() {
		if (!payload?.pendingCommit) return
		promoting = true
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
				promoting = false
				message = body?.error ?? 'Could not promote this commit.'
				handle.update()
				return
			}
			window.location.assign(payload.packageHref)
		} catch {
			promoting = false
			message = 'Could not promote this commit.'
			handle.update()
		}
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		if (!isApprovePublishPath(currentHref)) {
			return <AccountManagementShell>{null}</AccountManagementShell>
		}

		const snapshot = approvePublishData.read(handle, currentHref)
		if (snapshot.data && snapshot.data !== payload) {
			payload = snapshot.data
			message = null
		}
		if (snapshot.error && snapshot.error !== appliedError) {
			appliedError = snapshot.error
			message = snapshot.error.message
		}
		const pending = snapshot.kind === 'pending'
		const status: PageStatus =
			snapshot.kind === 'error'
				? 'error'
				: pending && payload === null
					? 'loading'
					: promoting
						? 'promoting'
						: 'ready'

		return (
			<AccountManagementShell busy={pending && payload !== null}>
				<AccountPageHeader
					title={
						payload?.package.lockedAt
							? 'Approve package publish'
							: 'Publish HEAD'
					}
					description={
						payload?.package.lockedAt
							? 'Review the files that changed since the last publish, then promote this commit. The package stays locked.'
							: 'Review the files that changed since the last publish, then publish default-branch HEAD. Runtime keeps using the published commit until you do.'
					}
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
									label: payload.package.lockedAt
										? 'Commit to promote'
										: 'HEAD to publish',
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
											? payload.package.lockedAt
												? 'Promoting…'
												: 'Publishing…'
											: payload.package.lockedAt
												? 'Promote this commit'
												: 'Publish HEAD'}
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
						<section
							data-testid="package-publish-diff"
							mix={css({ display: 'grid', gap: spacing.sm })}
						>
							<h3
								mix={css({
									margin: 0,
									fontSize: typography.fontSize.base,
									fontWeight: typography.fontWeight.semibold,
									color: colors.text,
								})}
							>
								{payload.alreadyPublished
									? 'No unpublished changes'
									: payload.diff.files.length === 0
										? 'Could not load a file diff for these commits'
										: `${payload.diff.files.length} file${payload.diff.files.length === 1 ? '' : 's'} changed`}
							</h3>
							{payload.diff.omittedCount > 0 ? (
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									{payload.diff.omittedCount} more file
									{payload.diff.omittedCount === 1 ? '' : 's'} omitted.
								</p>
							) : null}
							{payload.diff.files.map((file) => (
								<details
									key={file.path}
									data-testid="package-publish-diff-file"
									data-status={file.status}
									mix={css(diffFileCss)}
								>
									<summary mix={css(diffSummaryCss)}>
										<span mix={css(diffStatusCss)}>{file.status}</span>
										<code>{file.path}</code>
									</summary>
									{file.patch ? (
										<pre mix={css(diffPatchCss)}>{file.patch}</pre>
									) : (
										<p mix={css({ margin: 0, color: colors.textMuted })}>
											Preview unavailable for this file.
										</p>
									)}
								</details>
							))}
						</section>
					</section>
				) : null}
			</AccountManagementShell>
		)
	}
}

const diffFileCss = {
	margin: 0,
	borderRadius: '0.55rem',
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.background,
}

const diffSummaryCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.xs,
	padding: `${spacing.xs} ${spacing.sm}`,
	cursor: 'pointer',
	color: colors.text,
	'& code': {
		font: `500 0.85rem/1.3 ${typography.fontFamilyMono}`,
	},
}

const diffStatusCss = {
	flexShrink: 0,
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.semibold,
	textTransform: 'uppercase' as const,
	letterSpacing: '0.04em',
	color: colors.textMuted,
}

const diffPatchCss = {
	margin: 0,
	padding: spacing.sm,
	overflowX: 'auto' as const,
	borderTop: `1px solid ${colors.border}`,
	font: `400 0.78rem/1.45 ${typography.fontFamilyMono}`,
	whiteSpace: 'pre-wrap' as const,
	color: colors.text,
}
