import { type AccountSecretsLoaderData } from '#universal/loader-data.ts'
import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import {
	type ApprovalAction,
	type ApprovalView,
	accountSecretsApiPath,
	allowHostsButtonLabel,
	approvalRejectedHosts,
	approvalRequestedHosts,
	submitApprovalRequest,
} from '#client/routes/account-approval-shared.ts'
import {
	type RouteLoaderResult,
	routeLoaderRedirect,
} from '#client/route-loader.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	cardCss,
	getAccentCalloutCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	pageDescriptionCss,
	pageEyebrowCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import { routes } from '#universal/routes.ts'

const connectSecretsPageCss = {
	...stackedPageCss,
	maxWidth: '32rem',
	margin: '0 auto',
}

const connectSecretsHeaderCss = {
	...pageHeaderCss,
	justifyItems: 'center',
	textAlign: 'center' as const,
}

const connectSecretsPrimaryButtonCss = getPrimaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})

const connectSecretsSecondaryButtonCss = getSecondaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})

export async function connectSecretsRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const requestUrl = new URL(accountSecretsApiPath, url.origin)
	requestUrl.search = url.search
	const response = await fetch(`${requestUrl.pathname}${requestUrl.search}`, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = (await response.json().catch(() => null)) as
		| (AccountSecretsLoaderData & { error?: string })
		| null
	if (!response.ok || !payload?.ok) {
		return {
			accountSecrets: {
				ok: true,
				email: '',
				packageOptions: [],
				packages: [],
				secrets: [],
				selectedSecret: null,
				approval: null,
				approvalError:
					payload?.error || 'Unable to load this approval request.',
			},
		}
	}
	return { accountSecrets: payload }
}

export function ConnectSecretsRoute(handle: Handle) {
	let data: AccountSecretsLoaderData | null = null
	let submittingAction: ApprovalAction | null = null
	let message: string | null = null
	let completed: ApprovalAction | null = null

	function getCurrentHref() {
		return readCurrentRouterHref(handle)
	}

	function applyRouteLoaderData(href: string) {
		const routeData = tryConsumeRouteLoaderData(handle, 'accountSecrets', href)
		if (!routeData) return false
		data = routeData
		return true
	}

	async function submitApproval(action: ApprovalAction) {
		if (submittingAction != null || !data?.approval) return
		submittingAction = action
		message = null
		handle.update()
		try {
			const currentUrl = new URL(getCurrentHref(), 'http://localhost')
			const requestUrl = new URL(accountSecretsApiPath, currentUrl)
			requestUrl.search = currentUrl.search
			const payload = await submitApprovalRequest<
				AccountSecretsLoaderData & { error?: string; ok?: boolean }
			>(action, `${requestUrl.pathname}${requestUrl.search}`)
			if (!payload) return
			data = payload
			completed = action
			submittingAction = null
			handle.update()
		} catch (error) {
			submittingAction = null
			message =
				error instanceof Error ? error.message : 'Unable to process approval.'
			handle.update()
		}
	}

	return () => {
		const currentHref = getCurrentHref()
		applyRouteLoaderData(currentHref)
		const approval = data?.approval ?? null
		const rejectedHosts = approval ? approvalRejectedHosts(approval) : []
		const alreadyAllowed =
			approval != null &&
			completed !== 'reject' &&
			isConnectSecretsAlreadyAllowed({
				secrets: data?.secrets ?? [],
				approval,
			})
		const hosts = approval ? approvalRequestedHosts(approval) : []
		const names = approval?.names.length ? approval.names : []
		const onlyInvalid =
			hosts.length === 0 && rejectedHosts.length > 0 && completed !== 'reject'
		const fullyAllowed =
			(completed === 'approve' || alreadyAllowed) &&
			rejectedHosts.length === 0 &&
			!onlyInvalid
		const leftoverInvalid =
			rejectedHosts.length > 0 && (completed === 'approve' || alreadyAllowed)

		return (
			<section mix={css(connectSecretsPageCss)} data-testid="connect-secrets">
				<header mix={css(connectSecretsHeaderCss)}>
					<span mix={css(pageEyebrowCss)}>Allow secret hosts</span>
					<h1 mix={css(pageTitleCss)}>
						{fullyAllowed
							? 'Access allowed'
							: leftoverInvalid
								? 'Some hosts could not be allowed'
								: onlyInvalid
									? 'These hosts are not valid'
									: completed === 'reject'
										? 'Request rejected'
										: 'Allow this secret at these hosts'}
					</h1>
					<p mix={css(pageDescriptionCss)}>
						{fullyAllowed
							? 'Kody can send this saved secret to the hosts below.'
							: leftoverInvalid
								? 'Valid hosts were allowed. Invalid hosts from this link were not written to the allowlist — copy the approval link again if it was truncated.'
								: onlyInvalid
									? 'Kody did not treat these values as hosts you can allow. Copy the approval link again if it was truncated.'
									: completed === 'reject'
										? 'No hosts were added. You can approve later from this same link.'
										: approval
											? 'Kody only sends a saved secret to hosts you approve. Saving a secret does not do this automatically.'
											: 'Open an approval link from Kody to allow a saved secret at a host.'}
					</p>
				</header>

				{data?.approvalError ? (
					<section
						mix={css({
							...cardCss,
							border: `1px solid ${colors.danger}`,
						})}
						data-testid="connect-secrets-error"
					>
						<p mix={css({ margin: 0, color: colors.danger })}>
							{data.approvalError}
						</p>
					</section>
				) : null}

				{message ? (
					<p mix={css({ margin: 0, color: colors.danger })}>{message}</p>
				) : null}

				{approval && (hosts.length > 0 || rejectedHosts.length > 0) ? (
					<section mix={css(cardCss)} data-testid="connect-secrets-card">
						<div mix={css({ display: 'grid', gap: spacing.sm })}>
							<div mix={css({ display: 'grid', gap: spacing.xs })}>
								<span mix={css({ color: colors.textMuted })}>
									{names.length === 1 ? 'Secret' : 'Secrets'}
								</span>
								<ul
									mix={css({
										margin: 0,
										paddingLeft: spacing.lg,
										display: 'grid',
										gap: spacing.xs,
									})}
								>
									{names.map((name) => (
										<li key={name}>
											<code>{name}</code>
										</li>
									))}
								</ul>
							</div>
							{hosts.length > 0 ? (
								<div mix={css({ display: 'grid', gap: spacing.xs })}>
									<span mix={css({ color: colors.textMuted })}>
										{hosts.length === 1 ? 'Host' : 'Hosts'}
									</span>
									<ul
										mix={css({
											margin: 0,
											paddingLeft: spacing.lg,
											display: 'grid',
											gap: spacing.xs,
										})}
									>
										{hosts.map((host) => (
											<li key={host}>
												<strong mix={css({ color: colors.text })}>
													{host}
												</strong>
											</li>
										))}
									</ul>
								</div>
							) : null}
							{rejectedHosts.length > 0 ? (
								<div
									mix={css(getAccentCalloutCss({ accentColor: colors.danger }))}
									data-testid="connect-secrets-rejected-hosts"
								>
									<span mix={css({ color: colors.danger, fontWeight: 600 })}>
										{rejectedHosts.length === 1
											? 'This host is not valid'
											: `${rejectedHosts.length} hosts are not valid`}
									</span>
									<ul
										mix={css({
											margin: 0,
											paddingLeft: spacing.lg,
											display: 'grid',
											gap: spacing.xs,
										})}
									>
										{rejectedHosts.map((entry) => (
											<li key={entry.host}>
												<strong mix={css({ color: colors.text })}>
													{entry.host}
												</strong>
												<span mix={css({ color: colors.textMuted })}>
													{' '}
													— {entry.message}
												</span>
											</li>
										))}
									</ul>
								</div>
							) : null}
						</div>
						{fullyAllowed || alreadyAllowed || completed === 'reject' ? (
							<a
								href={routes.accountSecrets.href()}
								mix={css(connectSecretsSecondaryButtonCss)}
							>
								Back to secrets
							</a>
						) : (
							<div
								mix={css({
									display: 'flex',
									gap: spacing.sm,
									flexWrap: 'wrap',
								})}
							>
								{hosts.length > 0 && completed !== 'approve' ? (
									<button
										type="button"
										disabled={submittingAction != null}
										mix={[
											on('click', () => {
												void submitApproval('approve')
											}),
											css(connectSecretsPrimaryButtonCss),
										]}
									>
										{submittingAction === 'approve'
											? 'Allowing access…'
											: allowHostsButtonLabel(
													hosts.length,
													rejectedHosts.length,
												)}
									</button>
								) : null}
								<button
									type="button"
									disabled={submittingAction != null}
									mix={[
										on('click', () => {
											void submitApproval('reject')
										}),
										css(connectSecretsSecondaryButtonCss),
									]}
								>
									Reject
								</button>
							</div>
						)}
					</section>
				) : null}
			</section>
		)
	}
}

export function isConnectSecretsAlreadyAllowed(input: {
	secrets: AccountSecretsLoaderData['secrets']
	approval: ApprovalView
}) {
	if (approvalRequestedHosts(input.approval).length === 0) return false
	const pendingPairs = collectPendingHostPairs(input.secrets, input.approval)
	if (pendingPairs.length > 0) return false
	return input.approval.names.every((name) =>
		input.secrets.some(
			(item) => item.name === name && item.scope === input.approval.scope,
		),
	)
}

function collectPendingHostPairs(
	secrets: AccountSecretsLoaderData['secrets'],
	approval: ApprovalView,
) {
	const hosts = approvalRequestedHosts(approval)
	const pairs: Array<{ name: string; host: string }> = []
	for (const name of approval.names) {
		const secret = secrets.find(
			(item) => item.name === name && item.scope === approval.scope,
		)
		if (!secret) continue
		for (const host of hosts) {
			if (!secret.allowedHosts.includes(host)) {
				pairs.push({ name, host })
			}
		}
	}
	return pairs
}
