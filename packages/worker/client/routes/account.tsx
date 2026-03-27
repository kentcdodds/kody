import { type Handle } from 'remix/component'
import { navigate } from '#client/client-router.tsx'
import { colors, mq, spacing, typography } from '#client/styles/tokens.ts'

type AccountStatus = 'loading' | 'ready' | 'error'
type ApprovalAction = 'approve' | 'reject'
type SecretScope = 'session' | 'app' | 'user'

type SecretListItem = {
	name: string
	scope: SecretScope
	description: string
	appId: string | null
	appTitle: string | null
	allowedHosts: Array<string>
	createdAt: string
	updatedAt: string
	ttlMs: number | null
}

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
	secrets: Array<SecretListItem>
	approval: ApprovalView | null
}

const accountSecretsApiPath = '/account/secrets.json'

function getScopeLabel(scope: SecretScope) {
	if (scope === 'app') return 'App'
	if (scope === 'session') return 'Session'
	return 'User'
}

function formatRelativeTtl(ttlMs: number | null) {
	if (ttlMs == null) return 'No expiry'
	const totalMinutes = Math.max(1, Math.round(ttlMs / 60_000))
	if (totalMinutes < 60) return `Expires in ${totalMinutes} min`
	const totalHours = Math.round(totalMinutes / 60)
	if (totalHours < 48) return `Expires in ${totalHours} hr`
	const totalDays = Math.round(totalHours / 24)
	return `Expires in ${totalDays} day${totalDays === 1 ? '' : 's'}`
}

async function readJson<T>(response: Response) {
	return (await response.json().catch(() => null)) as T | null
}

export function AccountRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let email = ''
	let secrets: Array<SecretListItem> = []
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
			secrets = payload.secrets
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
			secrets = payload.secrets
			approval = payload.approval
			submittingApprovalAction = null
			message =
				action === 'approve'
					? 'Approved requested host.'
					: 'Rejected host approval request.'
			navigate('/account')
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
		if (status === 'loading' || currentHref !== lastLoadedHref) {
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
						{email ? `${email} secret approvals` : 'Secret approvals'}
					</h1>
					<p css={{ color: colors.textMuted, margin: 0 }}>
						Manage which hosts may receive stored secrets.
					</p>
				</header>

				{approval ? (
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
								disabled={submittingApprovalAction != null}
								css={primaryButtonCss}
							>
								Approve host
							</button>
							<button
								type="button"
								disabled={submittingApprovalAction != null}
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
					<section css={{ display: 'grid', gap: spacing.md }}>
						<h2
							css={{
								margin: 0,
								fontSize: typography.fontSize.lg,
								fontWeight: typography.fontWeight.semibold,
								color: colors.text,
							}}
						>
							Saved secrets
						</h2>
						{secrets.length === 0 ? (
							<p css={{ margin: 0, color: colors.textMuted }}>
								No user or app secrets are currently stored.
							</p>
						) : (
							<ul
								css={{
									listStyle: 'none',
									padding: 0,
									margin: 0,
									display: 'grid',
									gap: spacing.md,
								}}
							>
								{secrets.map((secret) => (
									<li
										key={`${secret.scope}:${secret.appId ?? 'global'}:${secret.name}`}
										css={{
											display: 'grid',
											gap: spacing.sm,
											padding: spacing.lg,
											border: `1px solid ${colors.border}`,
											borderRadius: '1rem',
											backgroundColor: colors.surface,
										}}
									>
										<div
											css={{
												display: 'flex',
												alignItems: 'baseline',
												justifyContent: 'space-between',
												gap: spacing.sm,
												flexWrap: 'wrap',
											}}
										>
											<div css={{ display: 'grid', gap: spacing.xs }}>
												<strong css={{ color: colors.text }}>{secret.name}</strong>
												<span css={{ color: colors.textMuted }}>
													{getScopeLabel(secret.scope)}
													{secret.appTitle ? ` - ${secret.appTitle}` : ''}
												</span>
											</div>
											<span css={{ color: colors.textMuted }}>
												{formatRelativeTtl(secret.ttlMs)}
											</span>
										</div>
										{secret.description ? (
											<p css={{ margin: 0, color: colors.textMuted }}>
												{secret.description}
											</p>
										) : null}
										<div css={{ display: 'grid', gap: spacing.xs }}>
											<span css={{ color: colors.textMuted }}>Allowed hosts</span>
											{secret.allowedHosts.length > 0 ? (
												<div
													css={{
														display: 'flex',
														flexWrap: 'wrap',
														gap: spacing.xs,
													}}
												>
													{secret.allowedHosts.map((host) => (
														<code
															key={host}
															css={{
																padding: `${spacing.xs} ${spacing.sm}`,
																borderRadius: '999px',
																backgroundColor: colors.primarySoftSubtle,
																color: colors.text,
															}}
														>
															{host}
														</code>
													))}
												</div>
											) : (
												<p css={{ margin: 0, color: colors.textMuted }}>
													No hosts approved yet.
												</p>
											)}
										</div>
									</li>
								))}
							</ul>
						)}
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
