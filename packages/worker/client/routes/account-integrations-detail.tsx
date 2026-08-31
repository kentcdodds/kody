import { formatTimestamp } from '#client/format-timestamp.ts'
import {
	type AccountIntegrationListItem,
	type AccountOauthAppListItem,
} from '#universal/loader-data.ts'
import { type RemixNode, css } from 'remix/ui'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { type createDoubleCheck } from '#client/double-check.ts'
import { ProviderMark } from '#client/provider-icons.tsx'
import { accountDisclosureCss } from '#client/routes/account-management-components.tsx'
import { recordBodyCss, recordCellClamp } from '#client/routes/record-table.tsx'
import {
	buildAddAccountHref,
	isAddAccountFormOpen,
} from '#client/routes/integration-provider-catalog.ts'
import { integrationDisplayName } from '#client/routes/integration-filter.ts'
import { buildConnectOauthHref } from '#universal/oauth-connect.ts'
import {
	buildChangeIntegrationScopesPrompt,
	formatOauthScopeSummary,
	resolveOauthScopeMenu,
} from '#universal/oauth-scopes.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	cardTitleCss,
	descriptionCss,
	detailGridCss,
	detailItemCss,
	detailLabelCss,
	detailValueCss,
	getPillButtonCss,
	hoverMq,
	insetCardCss,
	primaryLinkCss,
	sectionTitleCss,
} from '#universal/styles/style-primitives.ts'
import {
	type IntegrationUsageDraft,
	accountsConnectedCopy,
	connectActionLabel,
	connectionLabel,
	connectionStatusLabel,
	dangerButtonCss,
	formatList,
	formatOptional,
	hostFromUrl,
	integrationsRoute,
	isBuiltInApp,
	oauthAppTitle,
} from '#client/routes/account-integrations-shared.ts'
import {
	AddAccountForm,
	ConnectionUsageForm,
	RotateCredentialsForm,
} from '#client/routes/account-integrations-forms.tsx'

const clampedCellCss = css(recordCellClamp(26))

function renderIntegrationDetail(label: string, value: string) {
	return (
		<div mix={css(detailItemCss)}>
			<span mix={css(detailLabelCss)}>{label}</span>
			<span mix={css(detailValueCss)}>{value}</span>
		</div>
	)
}

function BuiltInIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="100%"
			height="100%"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<path d="M15 13.25C17.3472 13.25 19.25 11.3472 19.25 9C19.25 6.65279 17.3472 4.75 15 4.75C12.6528 4.75 10.75 6.65279 10.75 9C10.75 9.31012 10.7832 9.61248 10.8463 9.90372L4.75 16V19.25H8L8.75 18.5V16.75H10.5L11.75 15.5V13.75H13.5L14.0963 13.1537C14.3875 13.2168 14.6899 13.25 15 13.25Z" />
			<path d="M16.5 8C16.5 8.27614 16.2761 8.5 16 8.5C15.7239 8.5 15.5 8.27614 15.5 8C15.5 7.72386 15.7239 7.5 16 7.5C16.2761 7.5 16.5 7.72386 16.5 8Z" />
		</svg>
	)
}

function renderBuiltInIndicator(input?: { tooltipId?: string }) {
	const tooltipId = input?.tooltipId
	if (!tooltipId) {
		return (
			<span
				data-testid="built-in-indicator"
				role="img"
				aria-label="Provided by Kody"
				title="Provided by Kody"
				mix={css(builtInBadgeCss)}
			>
				{BuiltInIcon()}
			</span>
		)
	}
	return (
		<button
			type="button"
			data-testid="built-in-indicator"
			aria-label="Provided by Kody"
			mix={css(builtInIndicatorCss)}
		>
			{BuiltInIcon()}
			<span id={tooltipId} role="tooltip" aria-hidden="true">
				Provided by Kody
			</span>
		</button>
	)
}

export function renderNamedProvider(input: {
	providerKey: string
	label: string
	logoPath?: string | null
	autoLogoPath?: string | null
	host?: string | null
	builtIn?: boolean
}) {
	return (
		<span
			mix={css({
				display: 'inline-flex',
				alignItems: 'center',
				gap: spacing.sm,
				minWidth: 0,
			})}
		>
			<ProviderMark
				providerKey={input.providerKey}
				label={input.label}
				logoPath={input.logoPath}
				autoLogoPath={input.autoLogoPath}
				host={input.host}
				size="1.75rem"
			/>
			<span mix={clampedCellCss}>{input.label}</span>
			{input.builtIn ? renderBuiltInIndicator() : null}
		</span>
	)
}

function renderAdvancedDetails(body: RemixNode) {
	return (
		<details mix={css(advancedDetailsCss)} data-testid="integration-advanced">
			<summary>Advanced details</summary>
			<div mix={css({ display: 'grid', gap: spacing.md })}>{body}</div>
		</details>
	)
}

export const advancedDetailsCss = {
	...accountDisclosureCss,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const builtInBadgeCss = {
	display: 'inline-grid',
	placeContent: 'center',
	boxSizing: 'border-box' as const,
	width: '1.35rem',
	height: '1.35rem',
	padding: '0.22rem',
	overflow: 'hidden',
	flex: 'none',
	borderRadius: radius.full,
	border: `1px solid ${colors.primary}`,
	backgroundColor: colors.primarySoft,
	color: colors.primaryText,
}

const builtInIndicatorCss = {
	position: 'relative' as const,
	display: 'inline-grid',
	placeContent: 'center',
	boxSizing: 'border-box' as const,
	width: '1.35rem',
	height: '1.35rem',
	padding: '0.22rem',
	appearance: 'none' as const,
	font: 'inherit',
	flex: 'none',
	borderRadius: radius.full,
	border: `1px solid ${colors.primary}`,
	backgroundColor: colors.primarySoft,
	color: colors.primaryText,
	cursor: 'help',
	'& [role="tooltip"]': {
		position: 'absolute' as const,
		left: '50%',
		bottom: 'calc(100% + 0.45rem)',
		transform: 'translateX(-50%)',
		width: 'max-content',
		maxWidth: 'min(16rem, calc(100vw - 2rem))',
		padding: `${spacing.xs} ${spacing.sm}`,
		borderRadius: radius.md,
		backgroundColor: colors.surface,
		color: colors.text,
		fontSize: typography.fontSize.sm,
		fontWeight: 400,
		lineHeight: 1.4,
		textAlign: 'left' as const,
		boxShadow: shadows.md,
		border: `1px solid ${colors.border}`,
		pointerEvents: 'none' as const,
		opacity: 0,
		visibility: 'hidden' as const,
		zIndex: 3,
	},
	'& [role="tooltip"]::after': {
		content: '""',
		position: 'absolute' as const,
		top: '100%',
		left: '50%',
		transform: 'translateX(-50%)',
		border: '6px solid transparent',
		borderTopColor: colors.surface,
	},
	[hoverMq]: {
		'&:hover [role="tooltip"]': {
			opacity: 1,
			visibility: 'visible' as const,
		},
	},
	'&:focus-visible [role="tooltip"]': {
		opacity: 1,
		visibility: 'visible' as const,
	},
}

const connectionCardCss = {
	...insetCardCss,
	display: 'grid',
	gap: spacing.sm,
	padding: spacing.md,
}

const highlightedConnectionCardCss = {
	...connectionCardCss,
	borderColor: colors.primary,
	boxShadow: `inset 3px 0 0 ${colors.primary}`,
	borderRadius: `0 ${radius.lg} ${radius.lg} 0`,
}

export type IntegrationRecordProps = {
	selectedApp: AccountOauthAppListItem
	integrations: ReadonlyArray<AccountIntegrationListItem>
	apps: ReadonlyArray<AccountOauthAppListItem>
	savedPackages: ReadonlyArray<{ id: string; kodyId: string }>
	highlightedConnectionName: string | null
	highlightedConnection: AccountIntegrationListItem | null
	currentHref: string
	currentSearch: string
	deleteAppCheck: ReturnType<typeof createDoubleCheck>
	getDisconnectCheck: (name: string) => ReturnType<typeof createDoubleCheck>
	startDeleteApp: (app: AccountOauthAppListItem) => Promise<void>
	startDisconnect: (connection: {
		name: string
		accountLabel?: string | null
	}) => Promise<void>
	usageDraftFor: (
		connection: AccountIntegrationListItem,
	) => IntegrationUsageDraft
	setUsageDraft: (name: string, draft: IntegrationUsageDraft) => void
	submitUsage: (connection: AccountIntegrationListItem) => Promise<void>
	usageSavingName: string | null
	onRotated: (app: AccountOauthAppListItem) => void
}

export function renderIntegrationRecord(props: IntegrationRecordProps) {
	const {
		selectedApp,
		integrations,
		apps,
		savedPackages,
		highlightedConnectionName,
		highlightedConnection,
		currentHref,
		currentSearch,
		deleteAppCheck,
		getDisconnectCheck,
		startDeleteApp,
		startDisconnect,
		usageDraftFor,
		setUsageDraft,
		submitUsage,
		usageSavingName,
		onRotated,
	} = props
	return (
		<section mix={css(recordBodyCss)}>
			<header
				mix={css({
					display: 'grid',
					justifyItems: 'start',
					gap: spacing.sm,
				})}
			>
				<ProviderMark
					providerKey={selectedApp.provider || selectedApp.slug}
					label={oauthAppTitle(selectedApp)}
					logoPath={selectedApp.platformLogoPath ?? selectedApp.logoPath}
					autoLogoPath={selectedApp.autoLogoPath}
					host={hostFromUrl(selectedApp.authorizeUrl ?? selectedApp.tokenUrl)}
				/>
				<div mix={css({ display: 'grid', gap: spacing.xs })}>
					<h2
						mix={css({
							...cardTitleCss,
							display: 'flex',
							alignItems: 'center',
							gap: spacing.sm,
						})}
					>
						{oauthAppTitle(selectedApp)}
						{isBuiltInApp(selectedApp)
							? renderBuiltInIndicator({
									tooltipId: 'built-in-tip-detail',
								})
							: null}
					</h2>
					<p mix={css(descriptionCss)}>
						{accountsConnectedCopy(selectedApp.connections.length)}
					</p>
					{isBuiltInApp(selectedApp) ? null : (
						<button
							type="button"
							data-testid="delete-integration"
							aria-label={
								deleteAppCheck.doubleCheck
									? `Confirm delete integration "${oauthAppTitle(selectedApp)}"`
									: `Delete integration "${oauthAppTitle(selectedApp)}"`
							}
							title={
								deleteAppCheck.doubleCheck
									? `Click again to delete "${oauthAppTitle(selectedApp)}" and every connected account`
									: `Delete "${oauthAppTitle(selectedApp)}" and every connected account`
							}
							mix={[
								...deleteAppCheck.getButtonMix({
									on: {
										click: () => {
											void startDeleteApp(selectedApp)
										},
									},
								}),
								css(dangerButtonCss),
							]}
						>
							{deleteAppCheck.doubleCheck
								? 'Confirm delete'
								: 'Delete integration'}
						</button>
					)}
				</div>
			</header>

			<section mix={css({ display: 'grid', gap: spacing.sm })}>
				<h3 mix={css(sectionTitleCss)}>Connections</h3>
				{selectedApp.connections.length === 0 ? (
					<div
						mix={css({
							display: 'grid',
							gap: spacing.sm,
							justifyItems: 'start',
						})}
					>
						<p mix={css(descriptionCss)}>No accounts connected yet.</p>
						<a
							href={buildConnectOauthHref({
								name: selectedApp.slug,
								appSlug: selectedApp.slug,
							})}
							mix={css({
								...getPillButtonCss({ size: 'sm' }),
								display: 'inline-flex',
								textDecoration: 'none',
							})}
						>
							Connect
						</a>
					</div>
				) : (
					<div
						mix={css({
							display: 'grid',
							gap: spacing.sm,
						})}
					>
						{selectedApp.connections.map((connectionRef) => {
							const connection = integrations.find(
								(entry) => entry.name === connectionRef.name,
							)
							const highlighted =
								connectionRef.name === highlightedConnectionName
							const status = connection
								? connectionStatusLabel(connection)
								: 'Needs setup'
							const connectHref = buildConnectOauthHref({
								name: connectionRef.name,
								appSlug: connection?.platform
									? undefined
									: (connection?.appSlug ?? selectedApp.slug),
							})
							const disconnectCheck = getDisconnectCheck(connectionRef.name)
							const confirmingDisconnect = disconnectCheck.doubleCheck
							const disconnectLabel = connectionLabel(
								connection ?? connectionRef,
							)
							return (
								<article
									key={connectionRef.name}
									data-testid="integration-connection"
									data-highlighted={highlighted ? 'true' : undefined}
									mix={css(
										highlighted
											? highlightedConnectionCardCss
											: connectionCardCss,
									)}
								>
									<div
										mix={css({
											display: 'grid',
											gap: spacing.xs,
										})}
									>
										<a
											href={integrationsRoute.buildDetailHref(
												connectionRef.name,
												currentSearch,
											)}
											data-prevent-scroll-reset
											mix={css(primaryLinkCss)}
										>
											{connection
												? integrationDisplayName(connection)
												: connectionRef.accountLabel?.trim() ||
													connectionRef.name}
										</a>
										<p
											mix={css({
												...descriptionCss,
												margin: 0,
											})}
										>
											<code>{connectionRef.name}</code>
											{' · '}
											{status}
											{connection
												? ` · ${formatOauthScopeSummary({
														selectedCount:
															connection.authorization?.scopes.length ?? 0,
														menuCount: resolveOauthScopeMenu({
															allowedScopes: connection.platformAllowedScopes,
															selectedScopes: connection.authorization?.scopes,
														}).length,
													})}`
												: ''}
											{connection
												? ` · ${
														connection.usageMode === 'packages'
															? 'Specific packages'
															: 'Any context'
													}`
												: ''}
										</p>
									</div>
									{connection ? (
										<ConnectionUsageForm
											connection={connection}
											savedPackages={savedPackages}
											draft={usageDraftFor(connection)}
											saving={usageSavingName === connection.name}
											onDraftChange={(draft) =>
												setUsageDraft(connection.name, draft)
											}
											onSave={() => void submitUsage(connection)}
										/>
									) : null}
									<div
										mix={css({
											display: 'flex',
											flexWrap: 'wrap',
											gap: spacing.xs,
										})}
									>
										<a
											href={connectHref}
											mix={css({
												...getPillButtonCss({
													size: 'sm',
												}),
												display: 'inline-flex',
												textDecoration: 'none',
											})}
										>
											{connectActionLabel(status)}
										</a>
										<button
											type="button"
											data-testid="disconnect-connection"
											aria-label={
												confirmingDisconnect
													? `Confirm disconnect ${disconnectLabel}`
													: `Disconnect ${disconnectLabel}`
											}
											title={
												confirmingDisconnect
													? `Click again to disconnect ${disconnectLabel}`
													: `Disconnect ${disconnectLabel}`
											}
											mix={[
												...disconnectCheck.getButtonMix({
													on: {
														click: () => {
															void startDisconnect(connection ?? connectionRef)
														},
													},
												}),
												css(dangerButtonCss),
											]}
										>
											{confirmingDisconnect
												? 'Confirm disconnect'
												: 'Disconnect'}
										</button>
									</div>
								</article>
							)
						})}
						<AddAccountForm
							slug={selectedApp.slug}
							existingNames={[
								...integrations.map((entry) => entry.name),
								...apps.map((app) => app.slug),
							]}
							open={isAddAccountFormOpen(currentHref)}
							openHref={buildAddAccountHref(currentHref)}
						/>
					</div>
				)}
			</section>

			{renderAdvancedDetails(
				<>
					<section mix={css(detailGridCss)}>
						{renderIntegrationDetail('Provider', selectedApp.provider)}
						{renderIntegrationDetail('Slug', selectedApp.slug)}
						{renderIntegrationDetail(
							'Label',
							formatOptional(selectedApp.label),
						)}
						{renderIntegrationDetail('Client ID', selectedApp.clientId)}
						{renderIntegrationDetail(
							'Client-secret secret name',
							formatOptional(selectedApp.clientSecretSecretName),
						)}
						{renderIntegrationDetail('Token URL', selectedApp.tokenUrl)}
						{renderIntegrationDetail(
							'Authorize URL',
							formatOptional(selectedApp.authorizeUrl),
						)}
						{renderIntegrationDetail(
							'API base URL',
							formatOptional(selectedApp.apiBaseUrl),
						)}
						{renderIntegrationDetail('Flow', selectedApp.flow)}
						{renderIntegrationDetail(
							'PKCE',
							selectedApp.usePkce == null
								? selectedApp.flow === 'pkce'
									? 'Default on'
									: 'Default off'
								: selectedApp.usePkce
									? 'Enabled'
									: 'Disabled',
						)}
						{renderIntegrationDetail(
							'Token exchange style',
							formatOptional(selectedApp.tokenExchangeStyle),
						)}
						{renderIntegrationDetail(
							'Created',
							formatTimestamp(selectedApp.createdAt),
						)}
						{renderIntegrationDetail(
							'Updated',
							formatTimestamp(selectedApp.updatedAt),
						)}
					</section>
					{highlightedConnection ? (
						<section mix={css(insetCardCss)}>
							<h3 mix={css(sectionTitleCss)}>Selected connection</h3>
							<div mix={css(detailGridCss)}>
								{renderIntegrationDetail(
									'Connection key',
									highlightedConnection.name,
								)}
								{renderIntegrationDetail(
									'Requested scopes',
									formatList(highlightedConnection.authorization?.scopes),
								)}
								{highlightedConnection.platformAllowedScopes &&
								highlightedConnection.platformAllowedScopes.length > 0
									? renderIntegrationDetail(
											'Available scopes',
											formatList(highlightedConnection.platformAllowedScopes),
										)
									: null}
								{renderIntegrationDetail(
									'Required hosts',
									formatList(highlightedConnection.requiredHosts),
								)}
								{renderIntegrationDetail(
									'Access token secret',
									highlightedConnection.accessTokenSecretName,
								)}
								{renderIntegrationDetail(
									'Refresh token secret',
									formatOptional(highlightedConnection.refreshTokenSecretName),
								)}
							</div>
							<p mix={css(descriptionCss)}>
								Need more access? Copy this prompt for your agent. It explains
								how to request more scopes and reconnect so the token matches.
							</p>
							<CopyTextButton
								value={buildChangeIntegrationScopesPrompt({
									name: highlightedConnection.name,
									platform: highlightedConnection.platform === true,
									currentScopes: highlightedConnection.authorization?.scopes,
									allowedScopes: highlightedConnection.platformAllowedScopes,
								})}
								idleLabel="Copy scope prompt"
								variant="ghost"
								size="sm"
							/>
						</section>
					) : null}
					{isBuiltInApp(selectedApp) ? null : (
						<section mix={css(insetCardCss)}>
							<h3 mix={css(sectionTitleCss)}>Rotate client credentials</h3>
							<p mix={css(descriptionCss)}>
								Rotating credentials updates this shared registration once.
								Every connection below will use the new client id and client
								secret on the next authorize or token exchange.
							</p>
							{selectedApp.connections.length > 0 ? (
								<ul
									mix={css({
										margin: 0,
										paddingLeft: spacing.lg,
										display: 'grid',
										gap: spacing.xs,
										color: colors.text,
									})}
								>
									{selectedApp.connections.map((connection) => (
										<li key={`rotate-${connection.name}`}>
											{connection.accountLabel?.trim() || connection.name} (
											<code>{connection.name}</code>)
										</li>
									))}
								</ul>
							) : (
								<p mix={css(descriptionCss)}>
									No connections currently share these credentials.
								</p>
							)}
							<RotateCredentialsForm app={selectedApp} onRotated={onRotated} />
						</section>
					)}
				</>,
			)}
		</section>
	)
}
