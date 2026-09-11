import { type Handle, type RemixNode, css } from 'remix/ui'
import { createDoubleCheck } from '#client/double-check.ts'
import { AccountManagementMessage } from '#client/routes/account-management-components.tsx'
import { renderPackageWebhookCard } from '#client/routes/package-webhook-card.tsx'
import {
	fetchPackageWebhooks,
	packageWebhooksSectionId,
	postPackageWebhookIntent,
	type WebhookIntent,
	webhookFailureMessage,
	webhookSuccessMessage,
	webhooksDocHref,
} from '#client/routes/webhooks-shared.ts'
import { type PackageWebhookListItem } from '#universal/loader-data.ts'
import { primaryLinkCss } from '#universal/styles/style-primitives.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import { detailSectionCss } from './community-detail-sections.tsx'

type MessageTone = 'info' | 'error'

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

type PackageRef = { username: string; kodyId: string }

type DoubleCheck = ReturnType<typeof createDoubleCheck>

const sectionCss = {
	...detailSectionCss,
	// The section is a hash target from the account index.
	scrollMarginTop: spacing.xl,
}

const cardListCss = {
	display: 'grid',
	gap: spacing.md,
	marginTop: spacing.lg,
}

const mutedCss = {
	margin: `${spacing.md} 0 0`,
	color: colors.textMuted,
}

/**
 * State for the Webhooks section of package settings: the package's declared
 * webhooks joined with minted state, plus the revealed URLs the owner has
 * asked for. Revealed URLs live only in this closure — never in a payload
 * the section re-renders from — and drop when the package changes.
 */
export function createPackageWebhooksController(handle: Handle) {
	let loadedFor = ''
	let status: LoadStatus = 'idle'
	let webhooks: Array<PackageWebhookListItem> = []
	let message: string | null = null
	let messageTone: MessageTone = 'info'
	let mutating = false
	const revealedUrls = new Map<string, string>()
	const rotateChecks = new Map<string, DoubleCheck>()
	const disableChecks = new Map<string, DoubleCheck>()

	function keyFor(ref: PackageRef) {
		return `${ref.username}/${ref.kodyId}`
	}

	function checkFor(map: Map<string, DoubleCheck>, id: string) {
		let check = map.get(id)
		if (!check) {
			check = createDoubleCheck(handle)
			map.set(id, check)
		}
		return check
	}

	function resetChecks() {
		for (const check of rotateChecks.values()) check.reset()
		for (const check of disableChecks.values()) check.reset()
	}

	function setMessage(next: string | null, tone: MessageTone = 'info') {
		message = next
		messageTone = tone
	}

	function applyWebhooks(next: Array<PackageWebhookListItem>) {
		webhooks = next
		resetChecks()
	}

	/**
	 * Fetch the section for `ref` once per package. Rendering queues this on
	 * every pass; the key check makes repeat calls free. A failed load keeps
	 * the key (and reports the error) rather than clearing it: the render
	 * that shows the error would otherwise queue the same fetch again and
	 * spin on a persistent failure.
	 */
	async function ensureLoaded(ref: PackageRef) {
		const key = keyFor(ref)
		if (!ref.username || !ref.kodyId || loadedFor === key) return
		loadedFor = key
		status = 'loading'
		webhooks = []
		revealedUrls.clear()
		rotateChecks.clear()
		disableChecks.clear()
		setMessage(null)
		handle.update()
		try {
			const result = await fetchPackageWebhooks(ref)
			if (loadedFor !== key) return
			if (result.kind === 'unauthorized') {
				window.location.assign('/login')
				return
			}
			applyWebhooks(result.payload.webhooks)
			status = 'ready'
		} catch (error) {
			if (loadedFor !== key) return
			status = 'error'
			setMessage(
				error instanceof Error ? error.message : 'Unable to load webhooks.',
				'error',
			)
		}
		handle.update()
	}

	async function runIntent(
		ref: PackageRef,
		webhook: PackageWebhookListItem,
		intent: WebhookIntent,
	) {
		if (mutating) return
		const key = keyFor(ref)
		mutating = true
		setMessage(null)
		handle.update()
		const result = await postPackageWebhookIntent({
			...ref,
			webhookName: webhook.name,
			intent,
		})
		mutating = false
		if (loadedFor !== key) {
			handle.update()
			return
		}
		switch (result.kind) {
			case 'unauthorized':
				window.location.assign('/login')
				return
			case 'error':
				setMessage(result.message || webhookFailureMessage(intent), 'error')
				break
			case 'ok': {
				applyWebhooks(result.payload.webhooks)
				if (intent === 'rotate') revealedUrls.delete(webhook.id)
				if (result.payload.revealed) {
					revealedUrls.set(
						result.payload.revealed.id,
						result.payload.revealed.url,
					)
				}
				setMessage(webhookSuccessMessage(intent))
				break
			}
			default: {
				const exhaustive: never = result
				throw new Error(`Unhandled intent result: ${String(exhaustive)}`)
			}
		}
		handle.update()
	}

	function render(ref: PackageRef): RemixNode {
		const isCurrent = loadedFor === keyFor(ref)
		const showReady = isCurrent && status === 'ready'
		const showLoading = !isCurrent || status === 'idle' || status === 'loading'
		const mintedCount = webhooks.filter((webhook) => webhook.minted).length
		return (
			<section
				id={packageWebhooksSectionId}
				aria-labelledby="package-webhooks-title"
				aria-busy={showLoading || mutating ? 'true' : undefined}
				data-testid="package-webhook-settings"
				mix={css(sectionCss)}
			>
				<h2 id="package-webhooks-title">Webhooks</h2>
				<p>
					Inbound webhook URLs this package declares in{' '}
					<code>package.json#kody.webhooks</code>. Mint a URL here, copy it into
					the provider that will POST to it, and rotate or disable it when it
					leaks or goes unused. Agents connected over MCP can mint and apply
					handles but never see these URLs.
				</p>

				{showLoading ? (
					<p role="status" mix={css(mutedCss)}>
						Loading webhooks…
					</p>
				) : null}

				{message ? (
					<div mix={css({ marginTop: spacing.md })}>
						<AccountManagementMessage
							tone={messageTone === 'error' ? 'error' : 'info'}
						>
							{message}
						</AccountManagementMessage>
					</div>
				) : null}

				{showReady && webhooks.length === 0 ? (
					<p mix={css(mutedCss)} data-testid="package-webhook-settings-empty">
						This package declares no webhooks yet. Add a{' '}
						<code>kody.webhooks</code> entry to its <code>package.json</code>{' '}
						and publish it.{' '}
						<a href={webhooksDocHref} mix={css(primaryLinkCss)}>
							Inbound webhooks docs
						</a>
					</p>
				) : null}

				{showReady && webhooks.length > 0 ? (
					<>
						<p mix={css(mutedCss)} data-testid="package-webhook-settings-count">
							{webhooks.length} declared · {mintedCount} minted
						</p>
						<div mix={css(cardListCss)}>
							{webhooks.map((webhook) =>
								renderPackageWebhookCard({
									webhook,
									revealedUrl: revealedUrls.get(webhook.id) ?? null,
									isMutating: mutating,
									rotateCheck: checkFor(rotateChecks, webhook.id),
									disableCheck: checkFor(disableChecks, webhook.id),
									onIntent: (intent) => {
										void runIntent(ref, webhook, intent)
									},
									onHideUrl: () => hideUrl(webhook),
								}),
							)}
						</div>
					</>
				) : null}
			</section>
		)
	}

	function hideUrl(webhook: Pick<PackageWebhookListItem, 'id'>) {
		revealedUrls.delete(webhook.id)
		handle.update()
	}

	return { ensureLoaded, runIntent, hideUrl, render }
}
