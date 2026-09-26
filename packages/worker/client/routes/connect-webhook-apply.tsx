import { type ConnectWebhookApplyLoaderData } from '#universal/loader-data.ts'
import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
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

const pageCss = {
	...stackedPageCss,
	maxWidth: '36rem',
	margin: '0 auto',
}

const headerCss = {
	...pageHeaderCss,
	justifyItems: 'center',
	textAlign: 'center' as const,
}

const primaryButtonCss = getPrimaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})

const secondaryButtonCss = getSecondaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})

const metaListCss = {
	display: 'grid',
	gap: spacing.xs,
	margin: 0,
	padding: 0,
	listStyle: 'none',
	fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
	fontSize: '0.85rem',
	color: colors.textMuted,
	overflowWrap: 'anywhere' as const,
}

function buildApproveApplyApiPath(href: string) {
	const pageUrl = new URL(href, 'http://localhost')
	const apiUrl = new URL(
		routes.accountWebhooksApproveApplyApi.href(),
		'http://localhost',
	)
	apiUrl.search = pageUrl.search
	return `${apiUrl.pathname}${apiUrl.search}`
}

export async function connectWebhookApplyRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(
		buildApproveApplyApiPath(`${url.pathname}${url.search}`),
		{
			headers: { Accept: 'application/json' },
			credentials: 'include',
			signal,
		},
	)
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = (await response
		.json()
		.catch(() => null)) as ConnectWebhookApplyLoaderData | null
	if (!payload) {
		return {
			connectWebhookApply: {
				ok: false,
				error: 'Unable to load this webhook apply approval.',
				handle: url.searchParams.get('handle'),
				fingerprint: url.searchParams.get('fingerprint'),
			},
		}
	}
	return { connectWebhookApply: payload }
}

export function ConnectWebhookApplyRoute(handle: Handle) {
	let data: ConnectWebhookApplyLoaderData | null = null
	let submitting: 'approve' | 'reject' | null = null
	let message: string | null = null

	function currentHref() {
		return readCurrentRouterHref(handle)
	}

	function applyLoaderData(href: string) {
		const next = tryConsumeRouteLoaderData(handle, 'connectWebhookApply', href)
		if (!next) return false
		data = next
		return true
	}

	async function submit(action: 'approve' | 'reject') {
		if (submitting || !data || !data.ok) return
		submitting = action
		message = null
		handle.update()
		try {
			const response = await fetch(buildApproveApplyApiPath(currentHref()), {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({ action }),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = (await response
				.json()
				.catch(() => null)) as ConnectWebhookApplyLoaderData | null
			if (!payload) {
				throw new Error('Unable to process this approval.')
			}
			data = payload
			message =
				action === 'approve' && payload.ok
					? 'Destination approved. Return to your agent and retry webhookUrlApply.'
					: payload.ok
						? null
						: payload.error
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'Unable to process approval.'
		} finally {
			submitting = null
			handle.update()
		}
	}

	return () => {
		const href = currentHref()
		applyLoaderData(href)
		const payload = data

		return (
			<section mix={css(pageCss)} data-testid="connect-webhook-apply">
				<header mix={css(headerCss)}>
					<p mix={css(pageEyebrowCss)}>Webhook apply approval</p>
					<h1 mix={css(pageTitleCss)}>Approve outbound destination</h1>
					<p mix={css(pageDescriptionCss)}>
						Same account approval flow as secret host approval
						(`/connect/secrets`), secret package grants, and locked-package
						publish approval. Allow only if you trust this exact registration
						request.
					</p>
				</header>

				{message ? (
					<p
						mix={css(getAccentCalloutCss())}
						data-testid="connect-webhook-apply-message"
					>
						{message}
					</p>
				) : null}

				{!payload ? (
					<p mix={css({ color: colors.textMuted, textAlign: 'center' })}>
						Loading approval…
					</p>
				) : !payload.ok ? (
					<section mix={css(cardCss)} data-testid="connect-webhook-apply-error">
						<p mix={css({ margin: 0 })}>{payload.error}</p>
					</section>
				) : (
					<section mix={css(cardCss)} data-testid="connect-webhook-apply-card">
						<p mix={css({ marginTop: 0 })}>
							Package <strong>{payload.packageName}</strong> (
							<code>{payload.packageKodyId}</code>) wants to register webhook{' '}
							<code>{payload.webhookName}</code> at this destination.
						</p>
						<ul mix={css(metaListCss)}>
							<li>method: {payload.destination.method}</li>
							<li>url: {payload.destination.url}</li>
							<li>
								injection sites:{' '}
								{payload.destination.injectionSites.join(', ') || '(none)'}
							</li>
							<li>
								headers:{' '}
								{payload.destination.headers.length > 0
									? payload.destination.headers
											.map((header) => `${header.name}=${header.value}`)
											.join('; ')
									: '(none)'}
							</li>
							<li>
								body:{' '}
								{payload.destination.body.length > 0
									? payload.destination.body
									: '(none)'}
							</li>
							<li>auth: {payload.destination.auth}</li>
							<li>fingerprint: {payload.fingerprint}</li>
						</ul>
						{payload.alreadyGranted ? (
							<p mix={css({ marginBottom: 0 })}>
								This exact destination is already approved. Ask your agent to
								retry <code>webhookUrlApply</code>.
							</p>
						) : (
							<div
								mix={css({
									display: 'flex',
									gap: spacing.sm,
									flexWrap: 'wrap',
									marginTop: spacing.md,
								})}
							>
								<button
									type="button"
									disabled={submitting != null}
									data-testid="connect-webhook-apply-allow"
									mix={[
										on('click', () => {
											void submit('approve')
										}),
										css(primaryButtonCss),
									]}
								>
									{submitting === 'approve'
										? 'Approving…'
										: 'Allow destination'}
								</button>
								<button
									type="button"
									disabled={submitting != null}
									data-testid="connect-webhook-apply-reject"
									mix={[
										on('click', () => {
											void submit('reject')
										}),
										css(secondaryButtonCss),
									]}
								>
									{submitting === 'reject' ? 'Rejecting…' : 'Reject'}
								</button>
							</div>
						)}
					</section>
				)}
			</section>
		)
	}
}
