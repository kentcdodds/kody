import { css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { type createDoubleCheck } from '#client/double-check.ts'
import {
	AccountManagementMessage,
	IdValue,
	MetadataGrid,
	TimestampValue,
	noticeCardCss,
} from '#client/routes/account-management-components.tsx'
import {
	packageWebhookCardId,
	type WebhookIntent,
	webhookDeliveriesHref,
	webhookModeLabel,
	webhookStatusColor,
	webhookStatusLabel,
	webhooksDocHref,
} from '#client/routes/webhooks-shared.ts'
import { CopyCard } from '#client/routes/onboarding-mcp-client-cards.tsx'
import { type PackageWebhookListItem } from '#universal/loader-data.ts'
import {
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
	mutedLinkCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

const primaryButtonCss = getPillButtonCss({ size: 'sm' })
const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
const dangerButtonCss = getDangerPillCss({ size: 'sm' })

type DoubleCheck = ReturnType<typeof createDoubleCheck>

const cardCss = {
	...noticeCardCss,
	// The card is a hash target from the account index; give the jump some
	// breathing room above the heading.
	scrollMarginTop: spacing.xl,
}

const cardHeadCss = {
	display: 'flex',
	alignItems: 'baseline',
	justifyContent: 'space-between',
	gap: spacing.md,
	flexWrap: 'wrap' as const,
}

const cardTitleCss = {
	margin: 0,
	fontSize: typography.fontSize.lg,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
	fontFamily: 'monospace',
}

const statusPillCss = {
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.semibold,
	whiteSpace: 'nowrap' as const,
}

function verificationValue(webhook: PackageWebhookListItem) {
	const verification = webhook.verification
	if (!verification) return 'URL secret only (no HMAC)'
	return (
		<span mix={css({ display: 'grid', gap: spacing.xs })}>
			<span>
				{verification.type} · <code>{verification.header}</code>
			</span>
			<span mix={css({ color: colors.textMuted })}>
				secret <code>{verification.secretName}</code>
				{verification.prefix ? ` · prefix ${verification.prefix}` : ''}
				{verification.signedPayload === 'timestamp.body'
					? ' · signs timestamp.body'
					: ''}
			</span>
		</span>
	)
}

function replayValue(webhook: PackageWebhookListItem) {
	const replay = webhook.replay
	if (!replay) return 'Not configured'
	const parts: Array<string> = []
	if (replay.deliveryIdHeader) {
		parts.push(`delivery id ${replay.deliveryIdHeader}`)
	}
	if (replay.timestampHeader) {
		parts.push(
			`timestamp ${replay.timestampHeader} (${replay.toleranceSeconds ?? 300}s)`,
		)
	}
	return parts.length > 0 ? parts.join(' · ') : 'Not configured'
}

/**
 * One declared webhook on package settings: metadata, the URL slot (Mint /
 * Reveal + Copy / Hide), and the Rotate and Enable / Disable actions. The
 * card never renders a URL it did not just receive from a reveal.
 */
export function renderPackageWebhookCard(input: {
	webhook: PackageWebhookListItem
	revealedUrl: string | null
	isMutating: boolean
	rotateCheck: DoubleCheck
	disableCheck: DoubleCheck
	onIntent: (intent: WebhookIntent) => void
	onHideUrl: () => void
}) {
	const {
		webhook,
		revealedUrl,
		isMutating,
		rotateCheck,
		disableCheck,
		onIntent,
		onHideUrl,
	} = input
	const webhookLabel = `${webhook.packageKodyId}/${webhook.name}`
	const titleId = `${packageWebhookCardId(webhook.name)}-title`
	return (
		<article
			id={packageWebhookCardId(webhook.name)}
			aria-labelledby={titleId}
			mix={css(cardCss)}
			data-testid="package-webhook-card"
			data-webhook-id={webhook.id}
		>
			<div mix={css({ display: 'grid', gap: spacing.xs })}>
				<div mix={css(cardHeadCss)}>
					<h3 id={titleId} mix={css(cardTitleCss)}>
						{webhook.name}
					</h3>
					<span
						mix={css({ ...statusPillCss, color: webhookStatusColor(webhook) })}
					>
						{webhookStatusLabel(webhook)}
					</span>
				</div>
				<p mix={css(descriptionCss)}>
					{webhook.description ??
						`Each delivery runs the bound export ${webhook.exportName}.`}
				</p>
			</div>

			<MetadataGrid
				items={[
					{
						label: 'Export',
						value: <code>{webhook.exportName}</code>,
					},
					{ label: 'Mode', value: webhookModeLabel(webhook) },
					{
						label: 'Rate limit',
						value: `${webhook.rateLimitPerMinute} / min`,
					},
					{ label: 'Verification', value: verificationValue(webhook) },
					{ label: 'Replay protection', value: replayValue(webhook) },
					{
						label: 'Handle',
						value: webhook.handle ? (
							<IdValue value={webhook.handle} label="webhook handle" />
						) : (
							'—'
						),
					},
					{ label: 'URL host', value: webhook.urlHost ?? '—' },
					{
						label: 'Minted',
						value: <TimestampValue value={webhook.createdAt} />,
					},
					{
						label: 'Rotated',
						value: <TimestampValue value={webhook.rotatedAt} />,
					},
					...(webhook.enabled && webhook.previousUrlActiveUntil
						? [
								{
									label: 'Previous URL',
									value: (
										<span>
											active until{' '}
											<TimestampValue value={webhook.previousUrlActiveUntil} />
										</span>
									),
								},
							]
						: []),
				]}
			/>

			<div mix={css(fieldCss)} data-testid="package-webhook-url">
				<span mix={css(fieldLabelCss)}>Webhook URL</span>
				{renderUrlSection({
					webhook,
					revealedUrl,
					isMutating,
					onIntent,
					onHideUrl,
				})}
			</div>

			{webhook.minted ? (
				<div
					mix={css({
						display: 'flex',
						gap: spacing.sm,
						flexWrap: 'wrap',
						alignItems: 'center',
					})}
				>
					{webhook.enabled ? (
						<button
							type="button"
							disabled={isMutating}
							aria-label={
								disableCheck.doubleCheck
									? `Confirm disable ${webhookLabel}`
									: `Disable ${webhookLabel}`
							}
							mix={[
								css(secondaryButtonCss),
								...disableCheck.getButtonMix({
									on: { click: () => onIntent('disable') },
								}),
							]}
						>
							{disableCheck.doubleCheck ? 'Confirm disable' : 'Disable'}
						</button>
					) : (
						<button
							type="button"
							disabled={isMutating}
							aria-label={`Enable ${webhookLabel}`}
							mix={[
								css(secondaryButtonCss),
								on('click', () => onIntent('enable')),
							]}
						>
							Enable
						</button>
					)}
					<button
						type="button"
						disabled={isMutating}
						aria-label={
							rotateCheck.doubleCheck
								? `Confirm rotate URL for ${webhookLabel}`
								: `Rotate URL for ${webhookLabel}`
						}
						mix={[
							css(dangerButtonCss),
							...rotateCheck.getButtonMix({
								on: { click: () => onIntent('rotate') },
							}),
						]}
					>
						{rotateCheck.doubleCheck ? 'Confirm rotate' : 'Rotate URL'}
					</button>
					<a href={webhookDeliveriesHref} mix={css(mutedLinkCss)}>
						Recent deliveries
					</a>
				</div>
			) : null}

			{rotateCheck.doubleCheck ? (
				<AccountManagementMessage tone="info">
					Rotating mints a new URL. The previous URL stays active for 24 hours,
					or until a delivery arrives on the new one.
				</AccountManagementMessage>
			) : null}

			{webhook.minted ? (
				<p mix={css(descriptionCss)}>
					Disabling answers 404 without deleting the mint; enabling restores the
					same URL. Removing the declaration from the package manifest retires
					the ingress.{' '}
					<a href={webhooksDocHref} mix={css(primaryLinkCss)}>
						Inbound webhooks docs
					</a>
				</p>
			) : null}
		</article>
	)
}

function renderUrlSection(input: {
	webhook: PackageWebhookListItem
	revealedUrl: string | null
	isMutating: boolean
	onIntent: (intent: WebhookIntent) => void
	onHideUrl: () => void
}) {
	const { webhook, revealedUrl, isMutating, onIntent, onHideUrl } = input
	if (!webhook.minted) {
		return (
			<div mix={css({ display: 'grid', gap: spacing.sm })}>
				<p mix={css({ margin: 0, color: colors.textMuted })}>
					No URL yet. Minting opens ingress for this webhook and shows the URL
					once so you can paste it into the provider. Treat it as a credential:
					anyone holding it can POST to this export.
				</p>
				<div>
					<button
						type="button"
						disabled={isMutating}
						aria-label={`Mint URL for ${webhook.packageKodyId}/${webhook.name}`}
						data-testid="package-webhook-mint"
						mix={[css(primaryButtonCss), on('click', () => onIntent('mint'))]}
					>
						Mint URL
					</button>
				</div>
			</div>
		)
	}
	if (revealedUrl) {
		return (
			<div mix={css({ display: 'grid', gap: spacing.sm })}>
				<CopyCard
					label="Webhook URL"
					value={revealedUrl}
					copyLabel="Copy webhook URL"
					variant="pill"
				/>
				<div>
					<button
						type="button"
						aria-label={`Hide URL for ${webhook.packageKodyId}/${webhook.name}`}
						data-testid="package-webhook-hide-url"
						mix={[css(secondaryButtonCss), on('click', onHideUrl)]}
					>
						Hide URL
					</button>
				</div>
			</div>
		)
	}
	if (!webhook.urlRecoverable) {
		return (
			<p mix={css({ margin: 0, color: colors.textMuted })}>
				This URL was minted before Kody kept a recoverable copy of the secret,
				so it cannot be shown here. Rotate it to get a URL you can copy.
			</p>
		)
	}
	return (
		<div mix={css({ display: 'grid', gap: spacing.sm })}>
			<p mix={css({ margin: 0, color: colors.textMuted })}>
				Hidden until you reveal it. Only you can see it here; agents connected
				over MCP never receive this URL. Each reveal is recorded in your account
				audit log.
			</p>
			<div>
				<button
					type="button"
					disabled={isMutating}
					aria-label={`Reveal URL for ${webhook.packageKodyId}/${webhook.name}`}
					data-testid="package-webhook-reveal"
					mix={[css(secondaryButtonCss), on('click', () => onIntent('reveal'))]}
				>
					Reveal URL
				</button>
			</div>
		</div>
	)
}
