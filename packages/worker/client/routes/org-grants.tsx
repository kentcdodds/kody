import { css, type Handle } from 'remix/component'
import { createDoubleCheck } from '#client/double-check.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
} from '#client/routes/account-management-components.tsx'
import { renderIcon } from '#universal/icon.tsx'
import {
	type OrgGrantView,
	type OrgGrantsLoaderData,
} from '#universal/loader-data.ts'
import { orgCollaboratorsPath, orgTeamsPath } from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import { getDangerPillCss } from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

type GrantsPayload = OrgGrantsLoaderData & { error?: string }

async function fetchGrants(
	slug: string,
	signal: AbortSignal,
): Promise<GrantsPayload | 'unauthorized' | 'not-found'> {
	const response = await fetch(routes.orgGrantsApi.href({ orgSlug: slug }), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) return 'unauthorized'
	if (response.status === 404) return 'not-found'
	const payload = (await response
		.json()
		.catch(() => null)) as GrantsPayload | null
	if (!response.ok || !payload?.ok) {
		throw new Error(payload?.error || 'Unable to load grants.')
	}
	return payload
}

function slugFromHref(href: string) {
	const match = /^\/@([^/]+)\/-\/grants/.exec(
		new URL(href, 'http://localhost').pathname,
	)
	return match?.[1] ?? ''
}

function grantSummary(grant: OrgGrantView) {
	const access = grant.presetLabel ?? 'Custom permissions'
	return `${grant.subjectLabel} · ${access} on ${grant.resourceLabel}`
}

export async function orgGrantsRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const payload = await fetchGrants(slugFromHref(url.pathname), signal)
	if (payload === 'unauthorized') return routeLoaderRedirect('/login')
	if (payload === 'not-found') {
		return routeLoaderRedirect(routes.notFoundPage.href())
	}
	return { orgGrants: payload }
}

export function OrgGrantsRoute(handle: Handle) {
	const grantsData = createRouteData({
		key: 'orgGrants',
		async load(href, signal) {
			const payload = await fetchGrants(slugFromHref(href), signal)
			if (payload === 'unauthorized') return routeDataRedirect('/login')
			if (payload === 'not-found') throw new Error('Organization unavailable.')
			return payload
		},
	})

	const revokeChecks = new Map<string, ReturnType<typeof createDoubleCheck>>()
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'

	function revokeCheckFor(grantId: string) {
		const existing = revokeChecks.get(grantId)
		if (existing) return existing
		const created = createDoubleCheck(handle)
		revokeChecks.set(grantId, created)
		return created
	}

	async function revokeGrant(grantId: string) {
		const snapshot = grantsData.read(handle, readCurrentRouterHref(handle))
		const data = snapshot.data
		if (!data?.ok) return
		message = null
		handle.update()
		try {
			const response = await fetch(
				routes.orgGrantsRevokePost.href({ orgSlug: data.org.slug }),
				{
					method: 'POST',
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/json',
					},
					credentials: 'include',
					body: JSON.stringify({ grantId }),
				},
			)
			const payload = (await response
				.json()
				.catch(() => null)) as GrantsPayload | null
			if (response.status === 401) {
				window.location.assign('/login')
				throw new Error('Sign in again to continue.')
			}
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to revoke that grant.')
			}
			grantsData.reload(handle, readCurrentRouterHref(handle))
			message = 'Grant revoked.'
			messageTone = 'info'
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'Unable to revoke that grant.'
			messageTone = 'error'
		}
		handle.update()
	}

	return () => {
		const href = readCurrentRouterHref(handle)
		tryConsumeRouteLoaderData(handle, 'orgGrants', href)
		const snapshot = grantsData.read(handle, href)
		const data = snapshot.data
		const pending = snapshot.kind === 'pending'

		return (
			<AccountManagementShell busy={pending && Boolean(data)}>
				<AccountPageHeader
					title="Grants"
					description="Who can use packages and other resources in this organization."
					currentHref={href}
				/>
				{snapshot.kind === 'error' ? (
					<AccountManagementMessage tone="error">
						{snapshot.error?.message ?? 'Unable to load grants.'}
					</AccountManagementMessage>
				) : null}
				{!data && snapshot.kind === 'pending' ? (
					<p role="status" mix={css(mutedCopyCss)}>
						Loading grants…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				) : null}
				{data?.ok ? (
					<AccountManagementPanel
						title="Access grants"
						ariaLabel="Organization grants"
					>
						{data.grants.length === 0 ? (
							<p mix={css(mutedCopyCss)} data-testid="org-grants-empty">
								No grants yet. Grant access with{' '}
								<code mix={css(codeCss)}>accessGrant</code> or invite someone to
								a package. Outside collaborators appear on{' '}
								<a href={orgCollaboratorsPath(data.org.slug)}>Collaborators</a>
								{data.org.role === 'owner' || data.org.role === 'member' ? (
									<>
										; team subjects are managed under{' '}
										<a href={orgTeamsPath(data.org.slug)}>Teams</a>
									</>
								) : null}
								.
							</p>
						) : (
							<ul mix={css(listCss)} data-testid="org-grants">
								{data.grants.map((grant) => {
									const check = revokeCheckFor(grant.id)
									return (
										<li
											key={grant.id}
											data-testid="org-grant"
											mix={css(rowItemCss)}
										>
											<div mix={css(rowCss)}>
												<span aria-hidden="true" mix={css(iconCss)}>
													{renderIcon(
														grant.subjectType === 'team' ? 'users' : 'user',
														{ size: '1.25rem' },
													)}
												</span>
												<span mix={css(rowTextCss)}>
													<span mix={css(rowNameCss)}>
														{grantSummary(grant)}
													</span>
													<span mix={css(rowDetailCss)}>
														{grant.resourceType}
														{grant.preset
															? ''
															: ` · ${grant.permissions.join(', ') || 'no permissions'}`}
													</span>
												</span>
												{data.canManage ? (
													<button
														type="button"
														mix={[
															css(getDangerPillCss({ size: 'sm' })),
															...check.getButtonMix({
																on: {
																	click: () => void revokeGrant(grant.id),
																},
															}),
														]}
													>
														{renderIcon('close', { size: '1.05rem' })}
														{check.doubleCheck ? 'Confirm revoke' : 'Revoke'}
													</button>
												) : null}
											</div>
										</li>
									)
								})}
							</ul>
						)}
					</AccountManagementPanel>
				) : null}
			</AccountManagementShell>
		)
	}
}

const mutedCopyCss = {
	margin: 0,
	color: colors.textMuted,
	lineHeight: 1.5,
}

const codeCss = {
	fontSize: '0.9em',
}

const listCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.sm,
}

const rowItemCss = {
	minWidth: 0,
}

const rowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.md,
	minWidth: 0,
	padding: '0.85rem 1rem',
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
}

const rowTextCss = {
	display: 'grid',
	gap: '0.15rem',
	minWidth: 0,
	flex: '1 1 auto',
}

const rowNameCss = {
	fontWeight: 650,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
}

const rowDetailCss = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
}

const iconCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '2.75rem',
	height: '2.75rem',
	borderRadius: radius.full,
	color: colors.textMuted,
	backgroundColor: colors.background,
	flexShrink: 0,
}
