import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { type createDoubleCheck } from '#client/double-check.ts'
import { ProviderMark } from '#client/provider-icons.tsx'
import {
	AccountManagementMessage,
	MetadataGrid,
	TimestampValue,
} from '#client/routes/account-management-components.tsx'
import { recordBodyCss } from '#client/routes/record-table.tsx'
import {
	type McpServerListItem,
	type McpServerUsageDraft,
	hostFromUrl,
	stateColor,
	stateLabel,
} from '#client/routes/account-mcp-servers-shared.tsx'
import { renderMcpOAuthErrorMessage } from '#client/routes/account-mcp-servers-oauth-error.tsx'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	type getDangerPillCss,
	type getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'

function McpServerUsageForm(
	handle: Handle<{
		server: McpServerListItem
		savedPackages: ReadonlyArray<{ id: string; kodyId: string }>
		draft: McpServerUsageDraft
		saving: boolean
		onDraftChange: (draft: McpServerUsageDraft) => void
		onSave: () => void
	}>,
) {
	return () => {
		const { server, savedPackages, draft, saving, onDraftChange, onSave } =
			handle.props
		return (
			<section
				data-testid="mcp-server-usage"
				mix={css({ display: 'grid', gap: spacing.xs })}
			>
				<p
					mix={css({
						...fieldLabelCss,
						margin: 0,
					})}
				>
					Usage
				</p>
				<p mix={css({ ...descriptionCss, margin: 0 })}>
					Limit this server so only listed packages can call{' '}
					<code>kody.mcp[&quot;{server.name}&quot;]</code>. Execute and other
					packages are denied.
				</p>
				<label
					mix={css({
						display: 'flex',
						gap: spacing.xs,
						alignItems: 'flex-start',
						color: colors.text,
						fontSize: typography.fontSize.sm,
					})}
				>
					<input
						type="radio"
						name={`mcp-usage-mode-${server.id}`}
						checked={draft.usageMode === 'any'}
						disabled={saving}
						mix={[
							on('change', () =>
								onDraftChange({
									usageMode: 'any',
									allowedPackageIds: [],
								}),
							),
						]}
					/>
					<span>Any context (execute and every package)</span>
				</label>
				<label
					mix={css({
						display: 'flex',
						gap: spacing.xs,
						alignItems: 'flex-start',
						color: colors.text,
						fontSize: typography.fontSize.sm,
					})}
				>
					<input
						type="radio"
						name={`mcp-usage-mode-${server.id}`}
						checked={draft.usageMode === 'packages'}
						disabled={saving}
						mix={[
							on('change', () =>
								onDraftChange({
									usageMode: 'packages',
									allowedPackageIds: draft.allowedPackageIds,
								}),
							),
						]}
					/>
					<span>Specific packages only</span>
				</label>
				{draft.usageMode === 'packages' ? (
					savedPackages.length === 0 ? (
						<p mix={css({ ...descriptionCss, margin: 0 })}>
							Save a package first, then approve it here. Execute cannot use
							this server while it is limited to specific packages.
						</p>
					) : (
						<div mix={css({ display: 'grid', gap: spacing.xs })}>
							{savedPackages.map((savedPackage) => {
								const checked = draft.allowedPackageIds.includes(
									savedPackage.id,
								)
								return (
									<label
										key={savedPackage.id}
										mix={css({
											display: 'flex',
											gap: spacing.xs,
											alignItems: 'center',
											fontSize: typography.fontSize.sm,
										})}
									>
										<input
											type="checkbox"
											checked={checked}
											disabled={saving}
											mix={[
												on('change', () =>
													onDraftChange({
														usageMode: 'packages',
														allowedPackageIds: checked
															? draft.allowedPackageIds.filter(
																	(id) => id !== savedPackage.id,
																)
															: [...draft.allowedPackageIds, savedPackage.id],
													}),
												),
											]}
										/>
										<span>{savedPackage.kodyId}</span>
									</label>
								)
							})}
						</div>
					)
				) : null}
				<button
					type="button"
					data-testid="save-mcp-server-usage"
					disabled={saving}
					mix={[css(getPillButtonCss({ size: 'sm' })), on('click', onSave)]}
				>
					{saving ? 'Saving…' : 'Save usage'}
				</button>
			</section>
		)
	}
}

export type McpServerDetailProps = {
	server: McpServerListItem
	savedPackages: ReadonlyArray<{ id: string; kodyId: string }>
	usageDraft: McpServerUsageDraft
	usageSaving: boolean
	isMutating: boolean
	deleteServerCheck: ReturnType<typeof createDoubleCheck>
	primaryButtonCss: ReturnType<typeof getPillButtonCss>
	secondaryButtonCss: ReturnType<typeof getGhostButtonCss>
	dangerButtonCss: ReturnType<typeof getDangerPillCss>
	oauthClientOrigin: string
	oauthCallbackUrl: string
	oauthClientMetadataUrl: string | null
	onUsageDraftChange: (draft: McpServerUsageDraft) => void
	onUsageSave: () => void
	onReconnect: () => void
	onRefresh: () => void
	onToggleEnabled: () => void
	onDelete: () => void
}

export function renderMcpServerDetail(props: McpServerDetailProps) {
	const {
		server,
		savedPackages,
		usageDraft,
		usageSaving,
		isMutating,
		deleteServerCheck,
		primaryButtonCss,
		secondaryButtonCss,
		dangerButtonCss,
		oauthClientOrigin,
		oauthCallbackUrl,
		oauthClientMetadataUrl,
		onUsageDraftChange,
		onUsageSave,
		onReconnect,
		onRefresh,
		onToggleEnabled,
		onDelete,
	} = props
	return (
		<section mix={css(recordBodyCss)}>
			<div
				mix={css({
					display: 'flex',
					alignItems: 'flex-start',
					gap: spacing.md,
				})}
			>
				<ProviderMark
					providerKey={server.name}
					label={server.name}
					autoLogoPath={server.autoLogoPath}
					catalogLogoPath={server.catalogLogoPath}
					host={hostFromUrl(server.url)}
				/>
				<div mix={css({ display: 'grid', gap: spacing.xs })}>
					<h2 mix={css(cardTitleCss)}>{server.name}</h2>
					<p mix={css(descriptionCss)}>
						Saved MCP server connection. Kody keeps OAuth tokens and connection
						state isolated to your account.
					</p>
				</div>
			</div>

			<MetadataGrid
				items={[
					{
						label: 'Status',
						value: (
							<span mix={css({ color: stateColor(server) })}>
								{stateLabel(server)}
							</span>
						),
					},
					{
						label: 'Tools',
						value: server.connected ? `${server.toolCount} discovered` : '—',
					},
					{
						label: 'Added',
						value: <TimestampValue value={server.createdAt} />,
					},
					{
						label: 'Updated',
						value: <TimestampValue value={server.updatedAt} />,
					},
				]}
			/>

			<div mix={css(fieldCss)}>
				<span mix={css(fieldLabelCss)}>Server URL</span>
				<code
					mix={css({
						padding: spacing.sm,
						borderRadius: radius.md,
						border: `1px solid ${colors.border}`,
						backgroundColor: colors.background,
						color: colors.text,
						fontFamily: 'monospace',
						fontSize: typography.fontSize.sm,
						overflowWrap: 'anywhere',
					})}
				>
					{server.url}
				</code>
			</div>

			{server.error
				? renderMcpOAuthErrorMessage({
						message: server.error,
						oauthClientOrigin,
						oauthCallbackUrl,
						oauthClientMetadataUrl,
						serverUrl: server.url,
					})
				: null}

			{server.state === 'authenticating' && !server.authUrl ? (
				<AccountManagementMessage tone="info">
					Authorization needed. Click Reconnect to create a new authorization
					link. You may need to approve access once more.
				</AccountManagementMessage>
			) : null}

			{server.authUrl && server.state === 'authenticating' ? (
				<div
					mix={css({
						display: 'grid',
						gap: spacing.sm,
						padding: spacing.md,
						borderRadius: radius.md,
						border: `1px solid ${colors.primary}`,
						backgroundColor: colors.primarySoftest,
					})}
				>
					<span mix={css({ color: colors.text })}>
						Authorization needed. Approve access before this server&apos;s tools
						become available.
					</span>
					<div>
						<a
							href={server.authUrl}
							rel="noopener noreferrer"
							mix={css({
								...primaryButtonCss,
								display: 'inline-block',
								textDecoration: 'none',
							})}
						>
							Authorize {server.name}
						</a>
					</div>
				</div>
			) : null}

			<McpServerUsageForm
				server={server}
				savedPackages={savedPackages}
				draft={usageDraft}
				saving={usageSaving}
				onDraftChange={onUsageDraftChange}
				onSave={onUsageSave}
			/>

			{server.connected && server.tools.length > 0 ? (
				<div mix={css(fieldCss)}>
					<span mix={css(fieldLabelCss)}>Discovered tools</span>
					<ul
						mix={css({
							margin: 0,
							paddingLeft: spacing.lg,
							color: colors.text,
							display: 'grid',
							gap: spacing.xs,
						})}
					>
						{server.tools.map((tool) => (
							<li key={tool}>
								<code
									mix={css({
										fontFamily: 'monospace',
										fontSize: typography.fontSize.sm,
									})}
								>
									{tool}
								</code>
							</li>
						))}
					</ul>
				</div>
			) : null}

			<div
				mix={css({
					display: 'flex',
					gap: spacing.sm,
					flexWrap: 'wrap',
				})}
			>
				<button
					type="button"
					disabled={isMutating}
					mix={[on('click', onReconnect), css(primaryButtonCss)]}
				>
					Reconnect
				</button>
				<button
					type="button"
					disabled={isMutating}
					mix={[on('click', onRefresh), css(secondaryButtonCss)]}
				>
					Refresh tools
				</button>
				<button
					type="button"
					disabled={isMutating}
					mix={[on('click', onToggleEnabled), css(secondaryButtonCss)]}
				>
					{server.enabled ? 'Disable' : 'Enable'}
				</button>
				<button
					type="button"
					disabled={isMutating}
					mix={[
						...deleteServerCheck.getButtonMix({
							on: { click: onDelete },
							resetAfterAction: false,
						}),
						css(dangerButtonCss),
					]}
				>
					{deleteServerCheck.doubleCheck ? 'Confirm remove' : 'Remove'}
				</button>
			</div>
		</section>
	)
}
