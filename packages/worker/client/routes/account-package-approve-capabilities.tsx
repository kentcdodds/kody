import { type Handle, type RemixNode, css } from 'remix/component'
import { createMatcher } from 'remix/route-pattern/match'
import { routes } from '#universal/routes.ts'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	AccountManagementHeader,
	AccountManagementMessage,
	AccountManagementShell,
	IdValue,
	MetadataGrid,
	accountDisclosureCss,
} from './account-management-components.tsx'
import { isCredentialKind } from '#universal/credential-contracts.ts'
import { credentialKindLabel } from '#universal/credentials-list.ts'
import {
	type AccountPackageApproveCapabilitiesLoaderData,
	type AccountPackagePendingApproval,
} from '#universal/loader-data.ts'
import {
	getAccentCalloutCss,
	getGhostButtonCss,
	getPrimaryButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'

type CapabilityEntry =
	AccountPackageApproveCapabilitiesLoaderData['entries'][number]

/**
 * The dependency on an entry's reach path, or null when only the package
 * itself reaches it. Deduped rows keep the longest path, so a dependency path
 * does not rule out the package also using the entry directly.
 */
function reachingDependency(entry: CapabilityEntry) {
	return entry.via.length > 1 ? (entry.via.at(-1) ?? null) : null
}

function credentialKindText(kind: string | undefined) {
	if (kind === undefined) return credentialKindLabel('secret')
	return isCredentialKind(kind) ? credentialKindLabel(kind) : kind
}

function credentialSummary(entry: CapabilityEntry) {
	const dependency = reachingDependency(entry)
	return `${credentialKindText(entry.credentialKind)} · ${
		dependency
			? `reachable through its dependency ${dependency}`
			: 'used by this package'
	}`
}

function storageSummary(entry: CapabilityEntry) {
	const dependency = reachingDependency(entry)
	return dependency
		? `Its dependency ${dependency} can save and read its own data.`
		: 'This package can save and read its own data.'
}

const credentialValuesNote = 'Credential values never appear here.'

function sentence(text: string) {
	const trimmed = text.trim()
	if (trimmed.length === 0) return trimmed
	return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/**
 * Page title and lead copy follow what is actually waiting. Public / internet
 * visibility is mentioned only when a went_public request is pending or the
 * page is the capability-set pin for internet-visible serving.
 */
function approveCapabilitiesPageCopy(
	payload: AccountPackageApproveCapabilitiesLoaderData,
) {
	const pending = payload.pendingApprovals
	const hasWentPublic = pending.some(
		(approval) => approval.reason === 'went_public',
	)
	const hasCredentialNeeds = pending.some(
		(approval) => approval.reason === 'credential_needs_changed',
	)
	if (pending.length > 0 && hasCredentialNeeds && !hasWentPublic) {
		const changeLines = pending.flatMap((approval) => approval.changes)
		const what =
			changeLines.length > 0
				? changeLines.map(sentence).join(' ')
				: 'This version changes the package’s credential needs.'
		return {
			title: 'Approve credential needs',
			description: `${what} The previously published version keeps running until you approve. ${credentialValuesNote}`,
			mentionInternet: false,
		}
	}
	if (pending.length > 0 && hasWentPublic) {
		return {
			title: 'Approve package changes',
			description: hasCredentialNeeds
				? `Review the credential and internet-visibility changes below. ${credentialValuesNote}`
				: `Approving turns on internet-visible serving for this package. ${credentialValuesNote}`,
			mentionInternet: true,
		}
	}
	if (payload.package.isInternetVisible) {
		return {
			title: 'Approve internet-visible capabilities',
			description: `${payload.package.name} is served on the public internet. Check what it can use before you re-approve. ${credentialValuesNote}`,
			mentionInternet: true,
		}
	}
	return {
		title: 'Approve internet-visible capabilities',
		description: `Before ${payload.package.name} is served on the public internet, check what it can use. ${credentialValuesNote}`,
		mentionInternet: true,
	}
}

function credentialsSectionIntro(input: {
	isInternetVisible: boolean
	mentionInternet: boolean
}) {
	// Credential-needs-only review must not imply the pending credentials are
	// already reachable via public requests (even on an internet-visible package).
	if (!input.mentionInternet) {
		return 'This publish asks to use these credentials.'
	}
	if (input.isInternetVisible) {
		return 'It is internet-visible, so requests from anyone can run code that uses these.'
	}
	return 'Once it is internet-visible, requests from anyone can run code that uses these.'
}

/**
 * Raw identifiers for the collapsed Details disclosure. The decision itself
 * reads in plain language; these are copy targets for support and agents.
 */
function approveCapabilitiesDetailItems(
	payload: AccountPackageApproveCapabilitiesLoaderData,
) {
	const items: Array<{ key: string; label: string; value: RemixNode }> = [
		{
			key: 'published-commit',
			label: 'Published commit',
			value: payload.publishedCommit ? (
				<IdValue value={payload.publishedCommit} label="published commit" />
			) : (
				'Not published'
			),
		},
		{
			key: 'fingerprint',
			label: 'Capability fingerprint',
			value: <IdValue value={payload.fingerprint} label="fingerprint" />,
		},
	]
	for (const entry of payload.entries) {
		if (entry.kind === 'credential' && entry.credentialId) {
			const name = entry.name ?? 'Credential'
			items.push({
				key: `credential:${entry.credentialId}`,
				label: `${name} credential ID`,
				value: (
					<IdValue value={entry.credentialId} label={`${name} credential ID`} />
				),
			})
		} else if (entry.kind === 'storage' && entry.storageId) {
			const dependency = reachingDependency(entry)
			const label = dependency
				? `Package storage ID (${dependency})`
				: 'Package storage ID'
			items.push({
				key: `storage:${entry.storageId}`,
				label,
				value: <IdValue value={entry.storageId} label={label} />,
			})
		}
	}
	return items
}

const approveCapabilitiesMatcher = createMatcher(
	routes.communityPackageApproveCapabilities.pattern,
)

type PageStatus = 'loading' | 'ready' | 'error' | 'approving'

const loadFailureMessage = 'Unable to load this capability approval.'

function isApproveCapabilitiesPath(href: string) {
	return (
		approveCapabilitiesMatcher.match(new URL(href, 'http://localhost')) !== null
	)
}

function buildApproveCapabilitiesApiUrl(href: string) {
	const url = new URL(href, 'http://localhost')
	const match = approveCapabilitiesMatcher.match(url)
	return routes.communityPackageApproveCapabilitiesApi.href({
		username: match?.params.username ?? '',
		kodyId: match?.params.kodyId ?? '',
	})
}

export async function accountPackageApproveCapabilitiesRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const href = `${url.pathname}${url.search}`
	const response = await fetch(buildApproveCapabilitiesApiUrl(href), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload =
		await readJson<AccountPackageApproveCapabilitiesLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load this capability approval.')
	}
	return { accountPackageApproveCapabilities: payload }
}

export function AccountPackageApproveCapabilitiesRoute(handle: Handle) {
	let payload: AccountPackageApproveCapabilitiesLoaderData | null = null
	let approving = false
	let message: string | null = null
	let appliedError: Error | null = null
	const approveCapabilitiesData = createRouteData({
		key: 'accountPackageApproveCapabilities',
		async load(href, signal) {
			const response = await fetch(buildApproveCapabilitiesApiUrl(href), {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			}).catch(() => null)
			if (!response) throw new Error(loadFailureMessage)
			if (response.status === 401) return routeDataRedirect('/login')
			const next =
				await readJson<AccountPackageApproveCapabilitiesLoaderData>(response)
			if (!response.ok || !next?.ok) throw new Error(loadFailureMessage)
			return next
		},
	})

	let approvingRequestId: string | null = null

	async function approvePending(approval: AccountPackagePendingApproval) {
		if (!payload || !approval.approveAction || approvingRequestId) return
		approvingRequestId = approval.id
		message = null
		handle.update()
		try {
			const response = await fetch(
				buildApproveCapabilitiesApiUrl(readCurrentRouterHref(handle)),
				{
					method: 'POST',
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/json',
					},
					credentials: 'include',
					body: JSON.stringify({
						action: approval.approveAction,
						packageId: payload.package.id,
						requestId: approval.id,
					}),
				},
			)
			const body = await readJson<{ ok?: boolean; error?: string }>(response)
			if (!response.ok || body?.ok === false) {
				approvingRequestId = null
				message = body?.error ?? 'Could not approve this publish.'
				handle.update()
				return
			}
			window.location.reload()
		} catch {
			approvingRequestId = null
			message = 'Could not approve this publish.'
			handle.update()
		}
	}

	async function approveCapabilities() {
		if (!payload?.publishedCommit || approving) return
		approving = true
		message = null
		handle.update()
		try {
			const response = await fetch(
				buildApproveCapabilitiesApiUrl(readCurrentRouterHref(handle)),
				{
					method: 'POST',
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/json',
					},
					credentials: 'include',
					body: JSON.stringify({
						action: 'approve-capabilities',
						packageId: payload.package.id,
						fingerprint: payload.fingerprint,
					}),
				},
			)
			const body = await readJson<{ ok?: boolean; error?: string }>(response)
			if (!response.ok || body?.ok === false) {
				approving = false
				message = body?.error ?? 'Could not approve capabilities.'
				handle.update()
				return
			}
			if (payload.package.isInternetVisible) {
				window.location.assign(payload.settingsHref)
			} else {
				// Capability pin recorded; went_public is now pending on this page.
				window.location.reload()
			}
		} catch {
			approving = false
			message = 'Could not approve capabilities.'
			handle.update()
		}
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		if (!isApproveCapabilitiesPath(currentHref)) {
			return <AccountManagementShell>{null}</AccountManagementShell>
		}

		const snapshot = approveCapabilitiesData.read(handle, currentHref)
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
					: approving
						? 'approving'
						: 'ready'

		const credentialEntries =
			payload?.entries.filter((entry) => entry.kind === 'credential') ?? []
		const storageEntries =
			payload?.entries.filter((entry) => entry.kind === 'storage') ?? []

		const pendingApprovals = payload?.pendingApprovals ?? []
		const pageCopy = payload
			? approveCapabilitiesPageCopy(payload)
			: {
					title: 'Approve package changes',
					description: `Review what this package asks for. ${credentialValuesNote}`,
					mentionInternet: false,
				}
		const hasWentPublicPending = pendingApprovals.some(
			(approval) => approval.reason === 'went_public',
		)
		const hasCredentialNeedsPending = pendingApprovals.some(
			(approval) => approval.reason === 'credential_needs_changed',
		)

		return (
			<AccountManagementShell
				busy={pending && payload !== null}
				maxWidth="46rem"
			>
				<AccountManagementHeader
					eyebrow={
						payload ? (
							<p
								data-testid="package-approve-capabilities-package"
								mix={css(packageContextCss)}
							>
								{payload.package.name}
							</p>
						) : null
					}
					title={pageCopy.title}
					description={pageCopy.description}
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
						This capability approval could not be loaded.
					</p>
				) : null}
				{payload &&
				pendingApprovals.length > 0 &&
				(status === 'ready' || status === 'approving') ? (
					<section
						data-testid="package-pending-approvals"
						aria-labelledby="package-pending-approvals-heading"
						mix={css({ display: 'grid', gap: spacing.md })}
					>
						<h2
							id="package-pending-approvals-heading"
							mix={css(heroHeadingCss)}
						>
							Waiting for your approval
						</h2>
						<p mix={css({ margin: 0, color: colors.textMuted })}>
							{hasWentPublicPending
								? 'Internet-visible serving stays off until you approve.'
								: hasCredentialNeedsPending
									? 'The previously published version keeps running until you approve.'
									: 'Nothing changes until you approve.'}
						</p>
						<ul mix={css(cardListCss)}>
							{pendingApprovals.map((approval) => (
								<li
									key={approval.id}
									data-testid="package-pending-approval"
									mix={css(capabilityRowCss)}
								>
									<strong mix={css(cardTitleCss)}>
										{approval.reasonLabel}
									</strong>
									{approval.changes.length > 0 ? (
										<ul mix={css({ margin: 0, color: colors.textMuted })}>
											{approval.changes.map((change) => (
												<li key={change}>{change}</li>
											))}
										</ul>
									) : null}
									<details mix={css(accountDisclosureCss)}>
										<summary>Details</summary>
										<MetadataGrid
											items={[
												{
													label:
														approval.reason === 'went_public'
															? 'Published commit'
															: 'Paused commit',
													value: (
														<IdValue
															value={approval.pendingCommit}
															label={
																approval.reason === 'went_public'
																	? 'published commit'
																	: 'paused commit'
															}
														/>
													),
												},
											]}
										/>
									</details>
									{approval.approveAction ? (
										<div>
											<button
												type="button"
												disabled={approvingRequestId !== null}
												data-testid="package-pending-approval-approve"
												mix={[
													css(getPrimaryButtonCss()),
													on('click', () => void approvePending(approval)),
												]}
											>
												{approvingRequestId === approval.id
													? 'Approving…'
													: approval.reason === 'went_public'
														? 'Approve and make internet-visible'
														: 'Approve and publish'}
											</button>
										</div>
									) : null}
								</li>
							))}
						</ul>
					</section>
				) : null}
				{payload && (status === 'ready' || status === 'approving') ? (
					<section
						data-testid="package-approve-capabilities-card"
						aria-label="Capability set"
						mix={css({ display: 'grid', gap: spacing.xl })}
					>
						{!payload.publishedCommit && pageCopy.mentionInternet ? (
							<div mix={css(getAccentCalloutCss())}>
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									Publish this package before approving internet-visible
									capabilities.
								</p>
							</div>
						) : null}
						{payload.fingerprintMatchesApproval ? (
							<div mix={css(getAccentCalloutCss())}>
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									This capability set is already approved
									{payload.latestApprovedAt
										? ` (${payload.latestApprovedAt})`
										: ''}
									{payload.package.isInternetVisible
										? '. Approving again keeps internet-visible on for the same set.'
										: '.'}
								</p>
							</div>
						) : null}
						<section
							data-testid="package-approve-capabilities-credentials"
							aria-labelledby="package-approve-capabilities-credentials-heading"
							mix={css({ display: 'grid', gap: spacing.md })}
						>
							<h2
								id="package-approve-capabilities-credentials-heading"
								mix={css(heroHeadingCss)}
							>
								Credentials
							</h2>
							{credentialEntries.length === 0 ? (
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									This package does not use any of your credentials.
								</p>
							) : (
								<>
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										{credentialsSectionIntro({
											isInternetVisible: payload.package.isInternetVisible,
											mentionInternet: pageCopy.mentionInternet,
										})}
									</p>
									<ul mix={css(cardListCss)}>
										{credentialEntries.map((entry) => (
											<li
												key={entry.credentialId ?? entry.name}
												data-testid="package-approve-capabilities-credential"
												mix={css(capabilityRowCss)}
											>
												<strong mix={css(cardTitleCss)}>
													{entry.name ?? 'Unnamed credential'}
												</strong>
												<span mix={css({ color: colors.textMuted })}>
													{credentialSummary(entry)}
												</span>
												<span mix={css({ color: colors.textMuted })}>
													{entry.hosts.length > 0
														? `Can only be sent to ${entry.hosts.join(', ')}`
														: 'No hosts approved yet'}
												</span>
											</li>
										))}
									</ul>
								</>
							)}
						</section>
						<section
							data-testid="package-approve-capabilities-other"
							aria-labelledby="package-approve-capabilities-other-heading"
							mix={css({ display: 'grid', gap: spacing.md })}
						>
							<h2
								id="package-approve-capabilities-other-heading"
								mix={css(heroHeadingCss)}
							>
								Other capabilities
							</h2>
							{storageEntries.length === 0 ? (
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									No other capabilities.
								</p>
							) : (
								<ul mix={css(cardListCss)}>
									{storageEntries.map((entry) => (
										<li
											key={entry.storageId}
											data-testid="package-approve-capabilities-storage"
											mix={css(capabilityRowCss)}
										>
											<strong mix={css(cardTitleCss)}>Package storage</strong>
											<span mix={css({ color: colors.textMuted })}>
												{storageSummary(entry)}
											</span>
										</li>
									))}
								</ul>
							)}
						</section>
						<div
							mix={css({
								display: 'flex',
								flexWrap: 'wrap',
								gap: spacing.sm,
								alignItems: 'center',
							})}
						>
							{pageCopy.mentionInternet ? (
								<button
									type="button"
									disabled={status === 'approving' || !payload.publishedCommit}
									data-testid="package-approve-capabilities"
									mix={[
										css(getPrimaryButtonCss()),
										on('click', () => void approveCapabilities()),
									]}
								>
									{status === 'approving'
										? 'Approving…'
										: payload.package.isInternetVisible
											? 'Re-approve capability set'
											: 'Approve capability set'}
								</button>
							) : null}
							<a
								href={payload.settingsHref}
								mix={css(getGhostButtonCss())}
								data-testid="package-approve-capabilities-back"
							>
								Back to package settings
							</a>
						</div>
						<details
							data-testid="package-approve-capabilities-details"
							mix={css(accountDisclosureCss)}
						>
							<summary>Details</summary>
							<MetadataGrid items={approveCapabilitiesDetailItems(payload)} />
						</details>
					</section>
				) : null}
			</AccountManagementShell>
		)
	}
}

const packageContextCss = {
	margin: 0,
	width: 'fit-content',
	maxWidth: '100%',
	overflowWrap: 'anywhere' as const,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.semibold,
	color: colors.primaryText,
	backgroundColor: colors.primarySoft,
	borderRadius: radius.full,
	padding: '0.2rem 0.7rem',
}

const heroHeadingCss = {
	margin: 0,
	fontSize: '1.35rem',
	fontWeight: 720,
	letterSpacing: '-0.014em',
	lineHeight: 1.2,
	color: colors.text,
}

const cardListCss = {
	margin: 0,
	padding: 0,
	listStyle: 'none',
	display: 'grid',
	gap: spacing.sm,
}

const cardTitleCss = {
	color: colors.text,
	fontSize: typography.fontSize.base,
	overflowWrap: 'anywhere' as const,
}

const capabilityRowCss = {
	display: 'grid',
	gap: spacing.xs,
	padding: spacing.md,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
	minWidth: 0,
}
