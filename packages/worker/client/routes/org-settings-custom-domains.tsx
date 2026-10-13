import { type Handle, css } from 'remix/component'
import { on } from '#client/event-mixin.ts'
import {
	AccountManagementPanel,
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
} from '#client/routes/account-management-components.tsx'
import {
	type OrgSettingsCustomDomainsView,
	type OrgSettingsLoaderData,
} from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

type SettingsPayload = OrgSettingsLoaderData & {
	error?: string
}

export function createOrgSettingsCustomDomains(
	handle: Handle,
	input: {
		onMessage: (message: string, tone: 'info' | 'error') => void
		reloadSettings: () => void
	},
) {
	let hostnameDraft = ''
	let bindingKindDraft: 'org' | 'app' = 'org'
	let packageIdDraft = ''
	let sslMethodDraft: 'http' | 'txt' = 'txt'
	let hostnameBusy: string | null = null
	/** Mutation responses update the list immediately; reload may skip while pending. */
	let customDomainsOverride: OrgSettingsCustomDomainsView | null | undefined
	let overrideOrgSlug: string | null = null

	function clearCustomDomainsOverride() {
		customDomainsOverride = undefined
		overrideOrgSlug = null
	}

	function serverCaughtUpWithOverride(
		override: OrgSettingsCustomDomainsView,
		server: OrgSettingsCustomDomainsView | null,
	) {
		if (!server) return false
		const byId = new Map(server.hostnames.map((row) => [row.id, row]))
		return (
			override.hostnames.every((row) => {
				const matched = byId.get(row.id)
				return Boolean(matched && matched.updatedAt >= row.updatedAt)
			}) && server.hostnames.length === override.hostnames.length
		)
	}

	async function mutateCustomHostname(args: {
		orgSlug: string
		canManage: boolean
		action: 'add' | 'sync' | 'delete'
		hostname?: string
		id?: string
		binding_kind?: 'app' | 'org'
		package_id?: string
		ssl_method?: 'http' | 'txt'
	}) {
		if (!args.canManage) return
		hostnameBusy =
			args.action === 'add'
				? 'add'
				: `${args.action}:${args.id ?? args.hostname ?? ''}`
		handle.update()
		try {
			const response = await fetch(
				routes.orgSettingsCustomHostnamesPost.href({
					orgSlug: args.orgSlug,
				}),
				{
					method: 'POST',
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/json',
					},
					credentials: 'include',
					body: JSON.stringify({
						action: args.action,
						hostname: args.hostname,
						id: args.id,
						binding_kind: args.binding_kind,
						package_id: args.package_id,
						ssl_method: args.ssl_method,
					}),
				},
			)
			const payload = (await response
				.json()
				.catch(() => null)) as SettingsPayload | null
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to update custom domains.')
			}
			customDomainsOverride = payload.customDomains
			overrideOrgSlug = args.orgSlug
			input.reloadSettings()
			if (args.action === 'add') {
				hostnameDraft = ''
				packageIdDraft = ''
			}
			input.onMessage(
				args.action === 'add'
					? 'Custom domain registered. Publish the verification records below, then sync.'
					: args.action === 'sync'
						? 'Custom domain status refreshed from Cloudflare.'
						: 'Custom domain removed.',
				'info',
			)
		} catch (error) {
			input.onMessage(
				error instanceof Error
					? error.message
					: 'Unable to update custom domains.',
				'error',
			)
		} finally {
			hostnameBusy = null
			handle.update()
		}
	}

	return {
		render(args: {
			orgSlug: string
			canManage: boolean
			customDomains: OrgSettingsCustomDomainsView | null
		}) {
			if (
				customDomainsOverride !== undefined &&
				overrideOrgSlug !== null &&
				overrideOrgSlug !== args.orgSlug
			) {
				clearCustomDomainsOverride()
			}
			if (
				hostnameBusy === null &&
				customDomainsOverride !== undefined &&
				(args.customDomains === null ||
					(customDomainsOverride !== null &&
						serverCaughtUpWithOverride(
							customDomainsOverride,
							args.customDomains,
						)))
			) {
				clearCustomDomainsOverride()
			}
			const customDomains =
				customDomainsOverride !== undefined
					? customDomainsOverride
					: args.customDomains
			if (!customDomains) return null

			return (
				<AccountManagementPanel title="Custom domains">
					<p mix={css(accountFieldNoteCss)}>
						Point a CNAME at{' '}
						<code mix={css(handleValueCss)}>
							{customDomains.dnsTarget ?? 'the package-app zone'}
						</code>
						, publish any ownership and SSL validation records shown per domain,
						then sync until hostname and certificate are both active. Prefer TXT
						SSL validation so the cert can issue before traffic switches (ADR
						0071).
					</p>
					{customDomains.hostnames.length === 0 ? (
						<p mix={css(mutedCopyCss)}>No custom domains yet.</p>
					) : (
						<ul mix={css(hostnameListCss)} data-testid="org-custom-hostnames">
							{customDomains.hostnames.map((row) => {
								const currentlyVerified =
									row.hostnameStatus === 'active' && row.sslStatus === 'active'
								const verificationRecords = [
									...(row.ownershipVerification
										? [row.ownershipVerification]
										: []),
									...row.sslValidationRecords,
								]
								return (
									<li mix={css(hostnameRowCss)} key={row.id}>
										<div mix={css(hostnameMetaCss)}>
											<strong mix={css(handleValueCss)}>{row.hostname}</strong>
											<span mix={css(identityDetailCss)}>
												{row.bindingKind === 'app' ? 'App' : 'Org'} · host{' '}
												{row.hostnameStatus} · ssl {row.sslStatus}
												{currentlyVerified ? ' · verified' : ''}
											</span>
											{!currentlyVerified && verificationRecords.length > 0 ? (
												<ul
													mix={css(verificationListCss)}
													data-testid={`org-custom-hostname-verification-${row.id}`}
												>
													{verificationRecords.map((record) => (
														<li
															key={`${record.type}:${record.name}:${record.value}`}
															mix={css(verificationRowCss)}
														>
															<span mix={css(identityDetailCss)}>
																{record.type.toUpperCase()}
															</span>
															<code mix={css(handleValueCss)}>
																{record.name}
															</code>
															<code mix={css(handleValueCss)}>
																{record.value}
															</code>
														</li>
													))}
												</ul>
											) : null}
										</div>
										{args.canManage ? (
											<div mix={css(hostnameActionsCss)}>
												<button
													type="button"
													disabled={hostnameBusy !== null}
													mix={[
														css(getGhostButtonCss({ size: 'sm' })),
														on(
															'click',
															() =>
																void mutateCustomHostname({
																	orgSlug: args.orgSlug,
																	canManage: args.canManage,
																	action: 'sync',
																	id: row.id,
																}),
														),
													]}
												>
													{hostnameBusy === `sync:${row.id}`
														? 'Syncing…'
														: 'Sync'}
												</button>
												<button
													type="button"
													disabled={hostnameBusy !== null}
													mix={[
														css(getGhostButtonCss({ size: 'sm' })),
														on(
															'click',
															() =>
																void mutateCustomHostname({
																	orgSlug: args.orgSlug,
																	canManage: args.canManage,
																	action: 'delete',
																	id: row.id,
																}),
														),
													]}
												>
													{hostnameBusy === `delete:${row.id}`
														? 'Removing…'
														: 'Remove'}
												</button>
											</div>
										) : null}
									</li>
								)
							})}
						</ul>
					)}
					{args.canManage ? (
						<form
							mix={[
								css(formCss),
								on('submit', (event) => {
									event.preventDefault()
									void mutateCustomHostname({
										orgSlug: args.orgSlug,
										canManage: args.canManage,
										action: 'add',
										hostname: hostnameDraft,
										binding_kind: bindingKindDraft,
										package_id:
											bindingKindDraft === 'app' ? packageIdDraft : undefined,
										ssl_method: sslMethodDraft,
									})
								}),
							]}
						>
							<label mix={css(accountFieldCss)}>
								<span mix={css(accountFieldLabelCss)}>Hostname</span>
								<input
									required
									value={hostnameDraft}
									placeholder="apps.example.com"
									data-field-ring
									mix={[
										css(accountInputCss),
										on('input', (event) => {
											hostnameDraft = (event.currentTarget as HTMLInputElement)
												.value
											handle.update()
										}),
									]}
								/>
							</label>
							<label mix={css(accountFieldCss)}>
								<span mix={css(accountFieldLabelCss)}>Binding</span>
								<select
									value={bindingKindDraft}
									mix={[
										css(accountInputCss),
										on('change', (event) => {
											bindingKindDraft = (
												event.currentTarget as HTMLSelectElement
											).value as 'org' | 'app'
											handle.update()
										}),
									]}
								>
									<option value="org">Org (private apps at /packages/…)</option>
									<option value="app">
										App (one public internet-visible app at /)
									</option>
								</select>
							</label>
							{bindingKindDraft === 'app' ? (
								<label mix={css(accountFieldCss)}>
									<span mix={css(accountFieldLabelCss)}>Package id</span>
									<input
										required
										value={packageIdDraft}
										data-field-ring
										mix={[
											css(accountInputCss),
											on('input', (event) => {
												packageIdDraft = (
													event.currentTarget as HTMLInputElement
												).value
												handle.update()
											}),
										]}
									/>
								</label>
							) : null}
							<label mix={css(accountFieldCss)}>
								<span mix={css(accountFieldLabelCss)}>SSL method</span>
								<select
									value={sslMethodDraft}
									mix={[
										css(accountInputCss),
										on('change', (event) => {
											sslMethodDraft = (
												event.currentTarget as HTMLSelectElement
											).value as 'http' | 'txt'
											handle.update()
										}),
									]}
								>
									<option value="txt">TXT (pre-validate)</option>
									<option value="http">HTTP</option>
								</select>
							</label>
							<div mix={css(accountActionsCss)}>
								<button
									type="submit"
									disabled={hostnameBusy !== null}
									mix={css(getPillButtonCss({ size: 'sm' }))}
								>
									{hostnameBusy === 'add' ? 'Adding…' : 'Add domain'}
								</button>
							</div>
						</form>
					) : null}
				</AccountManagementPanel>
			)
		},
	}
}

const mutedCopyCss = {
	margin: 0,
	color: colors.textMuted,
}

const formCss = {
	display: 'grid',
	gap: spacing.lg,
	marginTop: spacing.md,
}

const handleValueCss = {
	margin: 0,
	fontFamily: typography.fontFamilyMono,
	color: colors.text,
}

const identityDetailCss = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
}

const hostnameListCss = {
	listStyle: 'none',
	margin: `${spacing.md} 0 0`,
	padding: 0,
	display: 'grid',
	gap: spacing.md,
}

const hostnameRowCss = {
	display: 'grid',
	gap: spacing.sm,
	paddingBottom: spacing.md,
	borderBottom: `1px solid ${colors.border}`,
	'&:last-child': {
		borderBottom: 'none',
		paddingBottom: 0,
	},
}

const hostnameMetaCss = {
	display: 'grid',
	gap: '0.2rem',
	minWidth: 0,
}

const hostnameActionsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
}

const verificationListCss = {
	listStyle: 'none',
	margin: `${spacing.sm} 0 0`,
	padding: 0,
	display: 'grid',
	gap: spacing.xs,
}

const verificationRowCss = {
	display: 'grid',
	gap: '0.15rem',
	fontSize: typography.fontSize.sm,
}
