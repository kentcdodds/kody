import { type Handle } from 'remix/component'
import { colors, mq, spacing, typography } from '#client/styles/tokens.ts'

type AccountStatus = 'loading' | 'ready' | 'error'
type ApprovalAction = 'approve' | 'reject'
type SecretScope = 'session' | 'app' | 'user'

type ApprovalView = {
	token: string
	name: string
	scope: SecretScope
	requestedHost: string
	currentAllowedHosts: Array<string>
}

type AccountSecretsPayload = {
	ok: true
	email: string
	approval: ApprovalView | null
}

const accountSecretsApiPath = '/account/secrets.json'

function getScopeLabel(scope: SecretScope) {
	if (scope === 'app') return 'App'
	if (scope === 'session') return 'Session'
	return 'User'
}

async function readJson<T>(response: Response) {
	return (await response.json().catch(() => null)) as T | null
}

export function AccountRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let email = ''
	let approval: ApprovalView | null = null
	let message: string | null = null
	let submittingApprovalAction: ApprovalAction | null = null
	let lastLoadedHref = ''

	async function loadAccountSecrets(signal: AbortSignal) {
		try {
			const href =
				typeof window === 'undefined' ? '/account' : window.location.href
			lastLoadedHref = href
			const response = await fetch(
				`${accountSecretsApiPath}${new URL(href).search}`,
				{
					headers: { Accept: 'application/json' },
					credentials: 'include',
					signal,
				},
			)
			if (signal.aborted) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<AccountSecretsPayload>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load your account secrets.')
			}
			email = payload.email
			approval = payload.approval
			status = 'ready'
			message = null
			submittingApprovalAction = null
			handle.update()
		} catch (error) {
			if (signal.aborted) return
			status = 'error'
			message =
				error instanceof Error ? error.message : 'Unable to load your account.'
			handle.update()
		}
	}

	async function submitApproval(action: ApprovalAction) {
		if (!approval || submittingApprovalAction != null) return
		submittingApprovalAction = action
		message = null
		handle.update()
		try {
			const response = await fetch(accountSecretsApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action,
					requestToken: approval.token,
				}),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AccountSecretsPayload & { error?: string; ok?: boolean }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to process approval.')
			}
			email = payload.email
			approval = payload.approval
			submittingApprovalAction = null
			message =
				action === 'approve'
					? 'Approved requested host.'
					: 'Rejected host approval request.'
			handle.update()
			if (typeof window !== 'undefined' && window.location.search) {
				window.history.replaceState(null, '', '/account')
				lastLoadedHref = window.location.href
			}
		} catch (error) {
			submittingApprovalAction = null
			message =
				error instanceof Error ? error.message : 'Unable to process approval.'
			handle.update()
		}
	}

	return () => {
		const currentHref =
			typeof window === 'undefined' ? '/account' : window.location.href
		const isRefreshingForLocationChange =
			status !== 'loading' && currentHref !== lastLoadedHref
		if (status === 'loading' || isRefreshingForLocationChange) {
			handle.queueTask(loadAccountSecrets)
		}

		return (
			<section
				css={{
					maxWidth: '64rem',
					margin: '0 auto',
					display: 'grid',
					gap: spacing.xl,
				}}
			>
				<header css={{ display: 'grid', gap: spacing.xs }}>
					<h1
						css={{
							fontSize: typography.fontSize.xl,
							fontWeight: typography.fontWeight.semibold,
							color: colors.text,
							margin: 0,
						}}
					>
						{email ? `${email} account` : 'Account'}
					</h1>
					<p css={{ color: colors.textMuted, margin: 0 }}>
						Review approval requests and manage your stored secrets.
					</p>
				</header>

				{approval && !isRefreshingForLocationChange ? (
					<section
						css={{
							display: 'grid',
							gap: spacing.md,
							padding: spacing.lg,
							borderRadius: '1rem',
							border: `1px solid ${colors.primary}`,
							backgroundColor: colors.primarySoftest,
						}}
					>
						<div css={{ display: 'grid', gap: spacing.xs }}>
							<h2
								css={{
									margin: 0,
									fontSize: typography.fontSize.lg,
									fontWeight: typography.fontWeight.semibold,
									color: colors.text,
								}}
							>
								Approve host access
							</h2>
							<p css={{ margin: 0, color: colors.textMuted }}>
								Allow <code>{approval.requestedHost}</code> to receive secret{' '}
								<code>{approval.name}</code> from the {approval.scope} scope.
							</p>
							<p css={{ margin: 0, color: colors.textMuted }}>
								Current allowed hosts:{' '}
								{approval.currentAllowedHosts.length > 0
									? approval.currentAllowedHosts.join(', ')
									: 'none'}
							</p>
						</div>
						<div css={{ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' }}>
							<button
								type="button"
								disabled={
									submittingApprovalAction != null ||
									isRefreshingForLocationChange
								}
								on={{ click: () => void submitApproval('approve') }}
								css={primaryButtonCss}
							>
								Approve host
							</button>
							<button
								type="button"
								disabled={
									submittingApprovalAction != null ||
									isRefreshingForLocationChange
								}
								on={{ click: () => void submitApproval('reject') }}
								css={secondaryButtonCss}
							>
								Reject
							</button>
						</div>
					</section>
				) : null}

				{status === 'loading' ? (
					<p css={{ color: colors.textMuted, margin: 0 }}>
						Loading secret approvals…
					</p>
				) : null}
				{message ? (
					<p
						css={{ color: status === 'error' ? colors.error : colors.text }}
						role="alert"
					>
						{message}
					</p>
				) : null}

				{status === 'ready' ? (
					<section
						css={{
							display: 'grid',
							gap: spacing.md,
							padding: spacing.lg,
							border: `1px solid ${colors.border}`,
							borderRadius: '1rem',
							backgroundColor: colors.surface,
						}}
					>
						<h2
							css={{
								margin: 0,
								fontSize: typography.fontSize.lg,
								fontWeight: typography.fontWeight.semibold,
								color: colors.text,
							}}
						>
							Secret management
						</h2>
						<p css={{ margin: 0, color: colors.textMuted }}>
							Create, edit, and delete secrets from the dedicated management page.
						</p>
						<div>
							<a
								href="/account/secrets"
								css={{
									color: colors.primaryText,
									textDecoration: 'none',
									fontWeight: typography.fontWeight.medium,
									'&:hover': {
										textDecoration: 'underline',
									},
								}}
							>
								Manage secrets
							</a>
						</div>
					</section>
				) : null}
			</section>
		)
	}
}

const primaryButtonCss = {
	padding: `${spacing.sm} ${spacing.md}`,
	borderRadius: '999px',
	border: 'none',
	backgroundColor: colors.primary,
	color: 'white',
	fontWeight: typography.fontWeight.medium,
	cursor: 'pointer',
	[mq.mobile]: {
		width: '100%',
	},
}

const secondaryButtonCss = {
	...primaryButtonCss,
	backgroundColor: 'transparent',
	color: colors.text,
	border: `1px solid ${colors.border}`,
}
