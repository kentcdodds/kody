import { type Handle } from 'remix/component'
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	primaryLinkCss,
} from '#client/styles/style-primitives.ts'
import {
	type AccountStatus,
	accountSecretsApiPath,
	readJson,
} from '#client/routes/account-approval-shared.ts'

type AccountSecretsPayload = {
	ok: true
	email: string
}

export function AccountRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let email = ''
	let message: string | null = null
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
			status = 'ready'
			message = null
			handle.update()
		} catch (error) {
			if (signal.aborted) return
			status = 'error'
			message =
				error instanceof Error ? error.message : 'Unable to load your account.'
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

				{status === 'loading' ? (
					<p css={{ color: colors.textMuted, margin: 0 }}>Loading account…</p>
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
					<>
						<section css={cardCss}>
							<h2 css={cardTitleCss}>Secret management</h2>
							<p css={descriptionCss}>
								Create, edit, and delete secrets from the dedicated management
								page.
							</p>
							<div>
								<a href="/account/secrets" css={primaryLinkCss}>
									Manage secrets
								</a>
							</div>
						</section>
						<section css={cardCss}>
							<h2 css={cardTitleCss}>Email settings</h2>
							<p css={descriptionCss}>
								Manage approved inbound senders and inspect stored inbound email
								messages, replies, and agent traces.
							</p>
							<div>
								<a href="/account/email" css={primaryLinkCss}>
									Manage email
								</a>
							</div>
						</section>
					</>
				) : null}
			</section>
		)
	}
}
