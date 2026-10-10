import { css, type Handle } from 'remix/component'
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
import {
	type OrgCollaboratorView,
	type OrgCollaboratorsLoaderData,
} from '#universal/loader-data.ts'
import { orgGrantsPath, orgIdentity } from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { UserAvatar } from '#universal/user-avatar.tsx'

type CollaboratorsPayload = OrgCollaboratorsLoaderData & { error?: string }

async function fetchCollaborators(
	slug: string,
	signal: AbortSignal,
): Promise<CollaboratorsPayload | 'unauthorized' | 'not-found'> {
	const response = await fetch(
		routes.orgCollaboratorsApi.href({ orgSlug: slug }),
		{
			headers: { Accept: 'application/json' },
			credentials: 'include',
			signal,
		},
	)
	if (response.status === 401) return 'unauthorized'
	if (response.status === 404) return 'not-found'
	const payload = (await response
		.json()
		.catch(() => null)) as CollaboratorsPayload | null
	if (!response.ok || !payload?.ok) {
		throw new Error(payload?.error || 'Unable to load collaborators.')
	}
	return payload
}

function slugFromHref(href: string) {
	const match = /^\/@([^/]+)\/-\/collaborators/.exec(
		new URL(href, 'http://localhost').pathname,
	)
	return match?.[1] ?? ''
}

function personLabel(person: OrgCollaboratorView) {
	return (
		person.displayName?.trim() ||
		(person.username ? `@${person.username}` : person.userId)
	)
}

export async function orgCollaboratorsRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const payload = await fetchCollaborators(slugFromHref(url.pathname), signal)
	if (payload === 'unauthorized') return routeLoaderRedirect('/login')
	if (payload === 'not-found') {
		return routeLoaderRedirect(routes.notFoundPage.href())
	}
	return { orgCollaborators: payload }
}

export function OrgCollaboratorsRoute(handle: Handle) {
	const collaboratorsData = createRouteData({
		key: 'orgCollaborators',
		async load(href, signal) {
			const payload = await fetchCollaborators(slugFromHref(href), signal)
			if (payload === 'unauthorized') return routeDataRedirect('/login')
			if (payload === 'not-found') throw new Error('Organization unavailable.')
			return payload
		},
	})

	return () => {
		const href = readCurrentRouterHref(handle)
		tryConsumeRouteLoaderData(handle, 'orgCollaborators', href)
		const snapshot = collaboratorsData.read(handle, href)
		const data = snapshot.data
		const pending = snapshot.kind === 'pending'

		return (
			<AccountManagementShell busy={pending && Boolean(data)}>
				<AccountPageHeader
					title="Collaborators"
					description="People with grants on this organization who are not members."
					currentHref={href}
				/>
				{snapshot.kind === 'error' ? (
					<AccountManagementMessage tone="error">
						{snapshot.error?.message ?? 'Unable to load collaborators.'}
					</AccountManagementMessage>
				) : null}
				{!data && snapshot.kind === 'pending' ? (
					<p role="status" mix={css(mutedCopyCss)}>
						Loading collaborators…
					</p>
				) : null}
				{data?.ok ? (
					<AccountManagementPanel
						title="Outside collaborators"
						ariaLabel="Outside collaborators"
					>
						{data.collaborators.length === 0 ? (
							<p mix={css(mutedCopyCss)} data-testid="org-collaborators-empty">
								No outside collaborators. Grant package access to someone who is
								not a member, or review live grants on{' '}
								<a href={orgGrantsPath(data.org.slug)}>Grants</a>.
							</p>
						) : (
							<ul mix={css(listCss)} data-testid="org-collaborators">
								{data.collaborators.map((person) => {
									const identity = orgIdentity(
										{
											slug: person.username ?? person.userId,
											displayName: person.displayName,
											personal: false,
											avatarUrl: person.avatarUrl,
										},
										{ displayName: '', avatarUrl: null },
									)
									return (
										<li
											key={person.userId}
											data-testid="org-collaborator"
											mix={css(rowItemCss)}
										>
											<div mix={css(rowCss)}>
												<UserAvatar
													displayName={identity.avatarName}
													avatarUrl={person.avatarUrl}
													size={44}
													variant="well"
												/>
												<span mix={css(rowTextCss)}>
													<span mix={css(rowNameCss)}>
														{personLabel(person)}
													</span>
													<span mix={css(rowDetailCss)}>
														{person.username ? `@${person.username} · ` : ''}
														{person.grants.length} grant
														{person.grants.length === 1 ? '' : 's'}
													</span>
													{person.grants.length > 0 ? (
														<ul mix={css(grantListCss)}>
															{person.grants.map((grant) => (
																<li key={grant.id}>
																	{grant.presetLabel ?? 'Custom'} on{' '}
																	{grant.resourceLabel}
																</li>
															))}
														</ul>
													) : null}
												</span>
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

const listCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.sm,
}

const grantListCss = {
	listStyle: 'none',
	margin: `${spacing.xs} 0 0`,
	padding: 0,
	display: 'grid',
	gap: '0.2rem',
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
}

const rowItemCss = {
	minWidth: 0,
}

const rowCss = {
	display: 'flex',
	alignItems: 'flex-start',
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
