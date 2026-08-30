import { type AccountIntegrationsLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { css } from 'remix/ui'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { on } from '#client/event-mixin.ts'
import { ProviderIcon } from '#client/provider-icons.tsx'
import { renderByokExplainer } from '#client/routes/byok-explainer.tsx'
import { recordBodyCss } from '#client/routes/record-table.tsx'
import {
	buildCustomIntegrationSetupPrompt,
	buildIntegrationSetupPrompt,
	integrationProviderSuggestions,
} from '#client/routes/integration-provider-catalog.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	getPillButtonCss,
	primaryLinkCss,
	sectionTitleCss,
} from '#universal/styles/style-primitives.ts'
import { advancedDetailsCss } from '#client/routes/account-integrations-detail.tsx'

const providerCatalogGridCss = {
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fit, minmax(min(22rem, 100%), 1fr))',
	gap: spacing.lg,
}

function PlugIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="1.25em"
			height="1.25em"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<path d="M12 22v-5" />
			<path d="M9 8V2" />
			<path d="M15 8V2" />
			<path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
		</svg>
	)
}

export function renderApprovalCard(props: {
	approval: NonNullable<AccountIntegrationsLoaderData['approval']>
	submitting: boolean
	onApprove: () => void
}) {
	const { approval, submitting, onApprove } = props
	return (
		<section
			data-testid="integration-approval-card"
			mix={css({
				display: 'grid',
				gap: spacing.md,
				padding: spacing.lg,
				borderRadius: radius.lg,
				border: `1px solid ${colors.primary}`,
				backgroundColor: colors.primarySoftest,
				marginBlockEnd: spacing.lg,
			})}
		>
			<div mix={css({ display: 'grid', gap: spacing.xs })}>
				<h2
					mix={css({
						margin: 0,
						fontSize: typography.fontSize.lg,
						fontWeight: typography.fontWeight.semibold,
						color: colors.text,
					})}
				>
					Approve integration access
				</h2>
				<p mix={css({ margin: 0, color: colors.textMuted })}>
					{approval.alreadyGranted ? (
						<>
							Package{' '}
							<strong mix={css({ color: colors.text })}>
								{approval.packageKodyId ?? approval.packageId}
							</strong>{' '}
							can already use integration <code>{approval.name}</code>
							{approval.usageMode === 'any' ? ' from any context.' : '.'}
						</>
					) : (
						<>
							Allow package{' '}
							<strong mix={css({ color: colors.text })}>
								{approval.packageKodyId ?? approval.packageId}
							</strong>{' '}
							to use integration <code>{approval.name}</code>.
						</>
					)}
				</p>
			</div>
			<div
				mix={css({
					display: 'flex',
					flexWrap: 'wrap',
					gap: spacing.xs,
				})}
			>
				{approval.alreadyGranted ? (
					<a
						href={routes.accountIntegrations.href()}
						mix={css({
							...getPillButtonCss({ size: 'sm' }),
							display: 'inline-flex',
							textDecoration: 'none',
						})}
					>
						Back to integrations
					</a>
				) : (
					<>
						<button
							type="button"
							data-testid="approve-integration-package"
							disabled={submitting}
							mix={[
								css(getPillButtonCss({ size: 'sm' })),
								on('click', onApprove),
							]}
						>
							{submitting ? 'Approving…' : 'Approve'}
						</button>
						<a
							href={routes.accountIntegrations.href()}
							mix={css({
								...getPillButtonCss({ size: 'sm' }),
								display: 'inline-flex',
								textDecoration: 'none',
							})}
						>
							Cancel
						</a>
					</>
				)}
			</div>
		</section>
	)
}

export function renderRecordNotFound(kind: 'connection' | 'integration') {
	return (
		<div
			mix={css({ ...recordBodyCss, gap: spacing.sm })}
			data-testid={`${kind}-not-found`}
		>
			<h2
				mix={css({
					margin: 0,
					fontSize: typography.fontSize.lg,
					fontWeight: typography.fontWeight.semibold,
					color: colors.text,
				})}
			>
				{kind === 'connection'
					? 'Connection not found'
					: 'Integration not found'}
			</h2>
			<p mix={css({ margin: 0, color: colors.textMuted })}>
				{kind === 'connection'
					? 'This connection does not exist for this account or is unavailable.'
					: 'This integration does not exist for this account or is unavailable.'}
			</p>
		</div>
	)
}

export function renderIntegrationsSetupSections(setupIntro: string) {
	return (
		<>
			<details
				mix={css(advancedDetailsCss)}
				data-testid="integrations-how-connections-work"
			>
				<summary>How connections work</summary>
				{renderByokExplainer({ image: 'keys' })}
			</details>

			<section mix={css({ display: 'grid', gap: spacing.lg })}>
				<div mix={css({ display: 'grid', gap: spacing.xs })}>
					<h2 mix={css(sectionTitleCss)}>Set up with your agent</h2>
					<p mix={css(descriptionCss)}>{setupIntro}</p>
				</div>

				<div mix={css(providerCatalogGridCss)}>
					{integrationProviderSuggestions.map((provider) => (
						<article key={provider.id} mix={css(cardCss)}>
							<div mix={css({ display: 'grid', gap: spacing.md })}>
								<div mix={css({ display: 'grid', gap: spacing.xs })}>
									<h3
										mix={css({
											...cardTitleCss,
											display: 'flex',
											alignItems: 'center',
											gap: spacing.sm,
										})}
									>
										<ProviderIcon providerId={provider.id} />
										{provider.name}
									</h3>
									<p mix={css(descriptionCss)}>{provider.tagline}</p>
									{provider.guideSlug ? (
										<p
											mix={css({
												margin: 0,
												fontSize: typography.fontSize.sm,
											})}
										>
											<a
												href={routes.guideDetail.href({
													slug: provider.guideSlug,
												})}
												mix={css(primaryLinkCss)}
											>
												Setup guide
											</a>
										</p>
									) : null}
								</div>
								<div>
									<CopyTextButton
										value={buildIntegrationSetupPrompt(provider)}
										idleLabel="Copy setup prompt"
										variant="ghost"
										size="sm"
									/>
								</div>
							</div>
						</article>
					))}

					<article mix={css(cardCss)}>
						<div mix={css({ display: 'grid', gap: spacing.md })}>
							<div mix={css({ display: 'grid', gap: spacing.xs })}>
								<h3
									mix={css({
										...cardTitleCss,
										display: 'flex',
										alignItems: 'center',
										gap: spacing.sm,
									})}
								>
									{PlugIcon()}
									Something else
								</h3>
								<p mix={css(descriptionCss)}>
									If it has an API, your Kody can learn to use it.
								</p>
							</div>
							<div>
								<CopyTextButton
									value={buildCustomIntegrationSetupPrompt()}
									idleLabel="Copy setup prompt"
									variant="ghost"
									size="sm"
								/>
							</div>
						</div>
					</article>
				</div>
			</section>
		</>
	)
}
