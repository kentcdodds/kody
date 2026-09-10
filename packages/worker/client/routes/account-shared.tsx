import { type Handle, css } from 'remix/ui'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
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
import { type AccountSharedLoaderData } from '#universal/loader-data.ts'
import { type PackageShareGrantLoaderView } from '#universal/package-share.ts'
import { routes } from '#universal/routes.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { on } from '#client/event-mixin.ts'
import { postPackageShareAction } from './package-share-client.ts'

const sharedApiPath = routes.accountSharedApi.href()

export async function accountSharedRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(sharedApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountSharedLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load shared packages.')
	}
	return { accountShared: payload }
}

export function AccountSharedRoute(handle: Handle) {
	let message: string | null = null
	let busy = false
	let payload: AccountSharedLoaderData | null = null
	const sharedData = createRouteData({
		key: 'accountShared',
		async load(_href, signal) {
			const response = await fetch(sharedApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (response.status === 401) return routeDataRedirect('/login')
			const next = await readJson<AccountSharedLoaderData>(response)
			if (!response.ok || !next?.ok) {
				throw new Error('Unable to load shared packages.')
			}
			return next
		},
	})

	async function runAction(
		input: Parameters<typeof postPackageShareAction>[0],
	) {
		if (busy) return
		busy = true
		message = null
		handle.update()
		const result = await postPackageShareAction(input)
		if (result.status === 'unauthorized') {
			window.location.assign('/login')
			return
		}
		if (result.status === 'error') {
			busy = false
			message = result.message
			handle.update()
			return
		}
		const response = await fetch(sharedApiPath, {
			headers: { Accept: 'application/json' },
			credentials: 'include',
		})
		const next = await readJson<AccountSharedLoaderData>(response)
		if (response.ok && next?.ok) payload = next
		busy = false
		handle.update()
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const snapshot = sharedData.read(handle, currentHref)
		if (snapshot.data && snapshot.data !== payload) {
			payload = snapshot.data
		}
		const data = payload
		const pending = snapshot.kind === 'pending'

		return (
			<AccountManagementShell busy={pending && data !== null}>
				<AccountPageHeader
					title="Shared"
					description="Packages you have shared, and packages shared with you."
					currentHref={currentHref}
				/>
				{message ? (
					<AccountManagementMessage>{message}</AccountManagementMessage>
				) : null}
				<AccountManagementPanel>
					<h2 mix={css(headingCss)}>Shared with you</h2>
					{renderGrantList({
						grants: data?.inbound ?? [],
						empty: 'Nothing is shared with you yet.',
						busy,
						guest: true,
						onAccept: (grant, trustLevel) =>
							void runAction({
								intent: 'accept',
								grantId: grant.id,
								trustLevel,
							}),
						onLeave: (grant) =>
							void runAction({ intent: 'leave', grantId: grant.id }),
					})}
				</AccountManagementPanel>
				<AccountManagementPanel>
					<h2 mix={css(headingCss)}>Shared by you</h2>
					{renderGrantList({
						grants: data?.outbound ?? [],
						empty: 'You have not shared a package yet.',
						busy,
						guest: false,
						onRevoke: (grant) =>
							void runAction({ intent: 'revoke', grantId: grant.id }),
					})}
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
}

function renderGrantList(input: {
	grants: Array<PackageShareGrantLoaderView>
	empty: string
	busy: boolean
	guest: boolean
	onAccept?: (
		grant: PackageShareGrantLoaderView,
		trustLevel: 'follow' | 'pin',
	) => void
	onLeave?: (grant: PackageShareGrantLoaderView) => void
	onRevoke?: (grant: PackageShareGrantLoaderView) => void
}) {
	const visible = input.grants.filter(
		(grant) => grant.status === 'pending' || grant.status === 'accepted',
	)
	if (visible.length === 0) {
		return <p mix={css(emptyCss)}>{input.empty}</p>
	}
	return (
		<ul mix={css(listCss)}>
			{visible.map((grant) => (
				<li key={grant.id}>
					<div>
						<a href={grant.packagePath}>{grant.packageName}</a>
						<span>
							{grant.status}
							{grant.trustLevel ? ` · ${grant.trustLevel}` : ''}
							{grant.pinAhead ? ' · pin ahead' : ''}
							{!input.guest && grant.granteeUsername
								? ` · @${grant.granteeUsername}`
								: ''}
							{!input.guest && !grant.granteeUsername && grant.inviteeEmail
								? ` · ${grant.inviteeEmail}`
								: ''}
						</span>
					</div>
					<div mix={css(actionsCss)}>
						{input.guest && grant.status === 'pending' ? (
							<>
								<button
									type="button"
									disabled={input.busy}
									mix={[
										css(getPillButtonCss({ size: 'sm' })),
										on('click', () => input.onAccept?.(grant, 'pin')),
									]}
								>
									Accept (pin)
								</button>
								<button
									type="button"
									disabled={input.busy}
									mix={[
										css(getGhostButtonCss({ size: 'sm' })),
										on('click', () => input.onAccept?.(grant, 'follow')),
									]}
								>
									Follow
								</button>
							</>
						) : null}
						{input.guest && grant.pinAhead && grant.approveChangesPath ? (
							<a
								href={grant.approveChangesPath}
								mix={css(getPillButtonCss({ size: 'sm' }))}
							>
								Approve changes
							</a>
						) : null}
						{input.guest && grant.status === 'accepted' ? (
							<button
								type="button"
								disabled={input.busy}
								mix={[
									css(getGhostButtonCss({ size: 'sm' })),
									on('click', () => input.onLeave?.(grant)),
								]}
							>
								Leave
							</button>
						) : null}
						{!input.guest ? (
							<button
								type="button"
								disabled={input.busy}
								mix={[
									css(getGhostButtonCss({ size: 'sm' })),
									on('click', () => input.onRevoke?.(grant)),
								]}
							>
								Revoke
							</button>
						) : null}
					</div>
				</li>
			))}
		</ul>
	)
}

const headingCss = {
	margin: `0 0 ${spacing.md}`,
	fontSize: '1.05rem',
}

const emptyCss = {
	margin: 0,
	color: colors.textMuted,
}

const listCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.sm,
	'& li': {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		gap: spacing.md,
		flexWrap: 'wrap' as const,
	},
	'& a': {
		color: colors.primaryText,
		fontWeight: 550,
		textDecoration: 'none',
	},
	'& span': {
		display: 'block',
		color: colors.textMuted,
		fontSize: '0.88rem',
	},
}

const actionsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
}
