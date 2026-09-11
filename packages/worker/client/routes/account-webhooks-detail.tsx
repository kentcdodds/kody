import { css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { type createDoubleCheck } from '#client/double-check.ts'
import {
	AccountManagementMessage,
	IdValue,
	MetadataGrid,
	TimestampValue,
} from '#client/routes/account-management-components.tsx'
import {
	webhookDeliveriesHref,
	webhookModeLabel,
	webhookStatusColor,
	webhookStatusLabel,
	webhooksDocHref,
} from '#client/routes/account-webhooks-shared.ts'
import { CopyCard } from '#client/routes/onboarding-mcp-client-cards.tsx'
import { recordBodyCss } from '#client/routes/record-table.tsx'
import { type AccountWebhookListItem } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	cardTitleCss,
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

export type WebhookIntent = 'mint' | 'rotate' | 'reveal' | 'enable' | 'disable'

type DoubleCheck = ReturnType<typeof createDoubleCheck>

function packageValue(username: string, webhook: AccountWebhookListItem) {
	if (!username) return webhook.packageName
	return (
		<a
			href={routes.communityPackage.href({
				username,
				kodyId: webhook.packageKodyId,
			})}
			mix={css(primaryLinkCss)}
		>
			{webhook.packageName}
		</a>
	)
}

function verificationValue(webhook: AccountWebhookListItem) {
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

function replayValue(webhook: AccountWebhookListItem) {
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

export function renderWebhookDetailPlaceholder(title: string, body: string) {
	return (
		<div mix={css({ ...recordBodyCss, gap: spacing.sm })}>
			<h2
				mix={css({
					margin: 0,
					fontSize: typography.fontSize.lg,
					fontWeight: typography.fontWeight.semibold,
					color: colors.text,
				})}
			>
				{title}
			</h2>
			<p mix={css({ margin: 0, color: colors.textMuted })}>{body}</p>
		</div>
	)
}

export function renderAccountWebhookDetail(input: {
	username: string
	webhook: AccountWebhookListItem
	revealedUrl: string | null
	isMutating: boolean
	rotateCheck: DoubleCheck
	disableCheck: DoubleCheck
	onIntent: (intent: WebhookIntent) => void
	onHideUrl: () => void
}) {
	const {
		username,
		webhook,
		revealedUrl,
		isMutating,
		rotateCheck,
		disableCheck,
		onIntent,
		onHideUrl,
	} = input
	const webhookLabel = `${webhook.packageKodyId}/${webhook.name}`
	return (
		<section
			mix={css(recordBodyCss)}
			data-testid="account-webhook-detail"
			data-webhook-id={webhook.id}
		>
			<div mix={css({ display: 'grid', gap: spacing.xs })}>
				<h2 mix={css(cardTitleCss)}>{webhook.name}</h2>
				<p mix={css(descriptionCss)}>
					{webhook.description ??
						`Declared by ${webhook.packageName}. Each delivery runs the bound export.`}
				</p>
			</div>

			<MetadataGrid
				items={[
					{ label: 'Package', value: packageValue(username, webhook) },
					{
						label: 'Export',
						value: <code>{webhook.exportName}</code>,
					},
					{
						label: 'Status',
						value: (
							<span mix={css({ color: webhookStatusColor(webhook) })}>
								{webhookStatusLabel(webhook)}
							</span>
						),
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
				]}
			/>

			<div mix={css(fieldCss)} data-testid="account-webhook-url">
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
					Rotating replaces the secret immediately. The current URL stops
					working and every provider that posts to it needs the new one.
				</AccountManagementMessage>
			) : null}

			<p mix={css(descriptionCss)}>
				Disabling answers 404 without deleting the mint; enabling restores the
				same URL. Removing the declaration from the package manifest retires the
				ingress.{' '}
				<a href={webhooksDocHref} mix={css(primaryLinkCss)}>
					Inbound webhooks docs
				</a>
			</p>
		</section>
	)
}

function renderUrlSection(input: {
	webhook: AccountWebhookListItem
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
						data-testid="account-webhook-mint"
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
						data-testid="account-webhook-hide-url"
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
					data-testid="account-webhook-reveal"
					mix={[css(secondaryButtonCss), on('click', () => onIntent('reveal'))]}
				>
					Reveal URL
				</button>
			</div>
		</div>
	)
}
