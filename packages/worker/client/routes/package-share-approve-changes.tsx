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
} from './account-management-components.tsx'
import { type PackageShareApproveChangesLoaderData } from '#universal/loader-data.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'

const matcher = createMatcher(routes.communityPackageApproveChanges.pattern)

function buildApproveChangesApiUrl(href: string) {
	const match = matcher.match(new URL(href, 'http://localhost'))
	return routes.communityPackageApproveChangesApi.href({
		username: match?.params.username ?? '',
		kodyId: match?.params.kodyId ?? '',
	})
}

export async function packageShareApproveChangesRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const href = `${url.pathname}${url.search}`
	const response = await fetch(buildApproveChangesApiUrl(href), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<PackageShareApproveChangesLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load shared package changes.')
	}
	return { packageShareApproveChanges: payload }
}

export function PackageShareApproveChangesRoute(handle: Handle) {
	let payload: PackageShareApproveChangesLoaderData | null = null
	let busy = false
	let message: string | null = null
	const approveData = createRouteData({
		key: 'packageShareApproveChanges',
		async load(href, signal) {
			const response = await fetch(buildApproveChangesApiUrl(href), {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			}).catch(() => null)
			if (!response) throw new Error('Unable to load shared package changes.')
			if (response.status === 401) return routeDataRedirect('/login')
			const next =
				await readJson<PackageShareApproveChangesLoaderData>(response)
			if (!response.ok || !next?.ok) {
				throw new Error('Unable to load shared package changes.')
			}
			return next
		},
	})

	async function approve(switchToFollow: boolean) {
		if (!payload || busy) return
		busy = true
		message = null
		handle.update()
		const response = await fetch(
			buildApproveChangesApiUrl(readCurrentRouterHref(handle)),
			{
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({ switchToFollow }),
			},
		).catch(() => null)
		busy = false
		if (!response) {
			message = 'Unable to approve these changes.'
			handle.update()
			return
		}
		if (response.status === 401) {
			window.location.assign('/login')
			return
		}
		const next = await readJson<{ ok: boolean; error?: string }>(response)
		if (!response.ok || !next?.ok) {
			message = next?.error ?? 'Unable to approve these changes.'
			handle.update()
			return
		}
		window.location.assign(payload.grant.packagePath)
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const snapshot = approveData.read(handle, currentHref)
		if (snapshot.data && snapshot.data !== payload) {
			payload = snapshot.data
		}
		const pending = snapshot.kind === 'pending'

		return (
			<AccountManagementShell busy={pending && payload !== null}>
				<AccountPageHeader
					title="Approve shared package changes"
					description="Review the published source that moved ahead of your pin, then accept it."
					currentHref={currentHref}
				/>
				{message ? (
					<AccountManagementMessage>{message}</AccountManagementMessage>
				) : null}
				{payload ? (
					<>
						<p mix={css(metaCss)}>
							{payload.grant.packageName} · accepted{' '}
							<code>{payload.acceptedCommit.slice(0, 7)}</code> → current{' '}
							<code>{payload.currentCommit.slice(0, 7)}</code>
						</p>
						<div mix={css(actionsCss)}>
							<button
								type="button"
								disabled={busy}
								mix={[
									css(getPillButtonCss()),
									on('click', () => void approve(false)),
								]}
							>
								Approve this version
							</button>
							<button
								type="button"
								disabled={busy}
								mix={[
									css(getGhostButtonCss()),
									on('click', () => void approve(true)),
								]}
							>
								Approve and follow future publishes
							</button>
							<a href={payload.grant.packagePath}>Back to package</a>
						</div>
						{payload.files.length === 0 ? (
							<p>No file-level source differences were available.</p>
						) : (
							payload.files.map((file) => (
								<section key={file.path} mix={css(fileCss)}>
									<h2>
										{file.change} · {file.path}
									</h2>
									{file.accepted ? (
										<pre>
											<code>{file.accepted}</code>
										</pre>
									) : null}
									{file.current ? (
										<pre>
											<code>{file.current}</code>
										</pre>
									) : null}
								</section>
							))
						)}
					</>
				) : (
					<p>Loading the published diff…</p>
				)}
			</AccountManagementShell>
		)
	}
}

const metaCss = {
	color: colors.textMuted,
	'& code': {
		font: '500 0.88rem/1.2 ui-monospace, "SF Mono", Menlo, monospace',
	},
}

const actionsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
	margin: `${spacing.lg} 0`,
	'& a': {
		alignSelf: 'center',
		color: colors.primaryText,
	},
}

const fileCss = {
	marginTop: spacing.xl,
	'& h2': {
		margin: `0 0 ${spacing.sm}`,
		fontSize: '1rem',
	},
	'& pre': {
		overflow: 'auto',
		padding: spacing.md,
		border: `1px solid ${colors.border}`,
		borderRadius: '0.5rem',
		background: colors.surface,
		fontSize: '0.82rem',
	},
}
