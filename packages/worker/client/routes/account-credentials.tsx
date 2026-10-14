import { type Handle, css } from 'remix/component'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { Combobox, type ComboboxOption } from '#client/combobox.tsx'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { replaceLocation } from '#client/replace-location.ts'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import { type AccountStatus } from '#client/routes/account-approval-shared.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
} from '#client/routes/account-management-components.tsx'
import { renderCredentialDetail } from '#client/routes/account-credential-detail.tsx'
import {
	credentialManageHref,
	credentialsDataKey,
	credentialsRoute,
	fetchAccountCredentials,
	readCredentialListFiltersFromHref,
	writeCredentialListFilters,
} from '#client/routes/account-credentials-shared.ts'
import {
	RecordTable,
	RecordTableSearch,
	RecordTableSelect,
	recordCellClamp,
} from '#client/routes/record-table.tsx'
import {
	type CredentialListFilters,
	type CredentialListItem,
	orgCredentialCreatePath,
	credentialKinds,
	isCredentialKind,
} from '#universal/credential-contracts.ts'
import {
	type AccountCredentialsResponse,
	type CredentialProviderBindingItem,
	credentialKindLabel,
	credentialStatusLabel,
	filterCredentialList,
} from '#universal/credentials-list.ts'
import { docHref } from '#universal/docs-nav.ts'
import { orgResourcePath, orgSlugFromPathname } from '#universal/org-pages.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'

const clampedCellCss = css(recordCellClamp(26))

const packageFilterSlotCss = {
	flex: '0 1 15rem',
	minWidth: '9rem',
	'@container (max-width: 620px)': { flex: '1 1 100%' },
}

const headerActionsCss = css({
	display: 'flex',
	flexWrap: 'wrap',
	gap: spacing.sm,
})

function credentialsAgentPrompt(input: { pageUrl: string; message: string }) {
	return [
		`I opened my credentials on Kody: ${input.pageUrl}`,
		`Kody said: ${input.message}`,
		'Help me find out why. Do not ask me to paste any credential value into chat.',
	].join('\n')
}

function renderCredentialsError(input: { pageUrl: string; message: string }) {
	return (
		<div
			data-testid="credentials-error"
			mix={css({ display: 'grid', justifyItems: 'start', gap: spacing.sm })}
		>
			<AccountManagementMessage tone="error">
				{input.message}
			</AccountManagementMessage>
			<CopyTextButton
				value={credentialsAgentPrompt(input)}
				idleLabel="Copy prompt for your agent"
			/>
		</div>
	)
}

function scopeLabel(credential: CredentialListItem) {
	return credential.scope === 'personal' ? 'Personal' : 'Org'
}

function statusColor(credential: CredentialListItem) {
	switch (credential.status) {
		case 'ok':
			return colors.text
		case 'expired':
		case 'needs_attention':
			return colors.error
		case 'disabled':
			return colors.textMuted
		default: {
			const exhaustive: never = credential.status
			return exhaustive
		}
	}
}

/** The kind, with its provider when that adds something. */
function kindCellLabel(credential: CredentialListItem) {
	const kind = credentialKindLabel(credential.kind)
	const provider = credential.provider
	return provider && provider !== credential.name
		? `${kind} · ${provider}`
		: kind
}

function hostsLabel(hosts: ReadonlyArray<string>) {
	if (hosts.length === 0) return '—'
	const [first, ...rest] = hosts
	return rest.length > 0 ? `${first} +${rest.length}` : (first ?? '—')
}

function packageLabel(
	credential: CredentialListItem,
	packagesById: ReadonlyMap<string, { kodyId: string }>,
) {
	const name = (id: string) => packagesById.get(id)?.kodyId ?? id
	if (credential.packageId)
		return `Package value · ${name(credential.packageId)}`
	const [first, ...rest] = credential.lockedToPackageIds
	if (!first) return '—'
	return rest.length > 0
		? `Locked to ${name(first)} +${rest.length}`
		: `Locked to ${name(first)}`
}

/**
 * Vault bindings are not a credential kind, so kind, owner, and package-scope
 * filters hide them; a chosen package keeps the vault it unlocks.
 */
function filterProviderBindings(
	providers: ReadonlyArray<CredentialProviderBindingItem>,
	filters: CredentialListFilters,
) {
	if (
		filters.kinds?.length ||
		filters.scope ||
		filters.packageScoped !== undefined ||
		filters.locked === true
	) {
		return []
	}
	const query = filters.q?.toLowerCase() ?? ''
	return providers.filter(
		(binding) =>
			(typeof filters.locked !== 'string' ||
				binding.packageId === filters.locked) &&
			(!query ||
				[binding.providerId, binding.provider ?? ''].some((text) =>
					text.toLowerCase().includes(query),
				)),
	)
}

const packageScopeOptions = ['any', 'scoped', 'unscoped', 'locked'] as const
type PackageScopeOption = (typeof packageScopeOptions)[number]

function packageScopeOption(
	filters: CredentialListFilters,
): PackageScopeOption {
	if (filters.packageScoped === true) return 'scoped'
	if (filters.packageScoped === false) return 'unscoped'
	if (filters.locked === true) return 'locked'
	return 'any'
}

/** Package-scope choice as filters. A chosen package (`locked: id`) stays. */
function packageScopeFilters(
	option: PackageScopeOption,
	current: CredentialListFilters,
): CredentialListFilters {
	const lockedPackage =
		typeof current.locked === 'string' ? current.locked : undefined
	switch (option) {
		case 'any':
			return { ...current, packageScoped: undefined, locked: lockedPackage }
		case 'scoped':
			return { ...current, packageScoped: true, locked: lockedPackage }
		case 'unscoped':
			return { ...current, packageScoped: false, locked: lockedPackage }
		case 'locked':
			return { ...current, packageScoped: undefined, locked: true }
		default: {
			const exhaustive: never = option
			return exhaustive
		}
	}
}

function isPackageScopeOption(value: string): value is PackageScopeOption {
	return (packageScopeOptions as ReadonlyArray<string>).includes(value)
}

/**
 * `/@slug/-/credentials`: every credential the org holds, whatever its kind
 * (Key, OAuth, MCP server, URL, login, signing, vault), in one searchable
 * list. Metadata only; values never reach this page.
 */
export function AccountCredentialsRoute(handle: Handle) {
	let payload: AccountCredentialsResponse | null = null
	const credentialsData = createRouteData({
		key: 'accountCredentials',
		locationKey: credentialsDataKey,
		async load(href, signal) {
			const result = await fetchAccountCredentials(href, signal)
			return result ?? routeDataRedirect('/login')
		},
	})

	function updateFilters(
		next: (current: CredentialListFilters) => CredentialListFilters,
	) {
		const href = readCurrentRouterHref(handle)
		replaceLocation(
			writeCredentialListFilters(
				href,
				next(readCredentialListFiltersFromHref(href)),
			),
		)
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const snapshot = credentialsData.read(handle, currentHref)
		const pageUrl =
			typeof window === 'undefined'
				? currentHref
				: new URL(currentHref, window.location.origin).href
		if (snapshot.data) payload = snapshot.data
		const pathOrgSlug = orgSlugFromPathname(
			new URL(currentHref, 'http://localhost').pathname,
		)
		// After an org switch, the last org's list must not stand in for this one.
		if (payload && pathOrgSlug && payload.orgSlug !== pathOrgSlug) {
			payload = null
		}
		const pending = snapshot.kind === 'pending'
		const status: AccountStatus =
			snapshot.kind === 'error'
				? 'error'
				: pending && payload === null
					? 'loading'
					: 'ready'
		const credentials = payload?.credentials ?? []
		const packages = payload?.packages ?? []
		const packagesById = new Map(packages.map((pkg) => [pkg.id, pkg]))
		const filters = readCredentialListFiltersFromHref(currentHref)
		const filtered = filterCredentialList(credentials, filters)
		const orgSlug = payload?.orgSlug ?? ''
		const teamOrg = payload?.teamOrg ?? false
		const selection = credentialsRoute.getSelection(currentHref)
		const search = new URL(currentHref, 'http://localhost').search
		const selectedItem =
			credentials.find((item) => item.id === selection.selectedId) ?? null
		const selectedDetail =
			payload?.selected && payload.selected.id === selection.selectedId
				? payload.selected
				: null
		const personalOrgSlug = payload?.personalOrgSlug ?? null
		// The open row stays visible so its pane can render under any filter.
		const shown =
			selectedItem && !filtered.includes(selectedItem)
				? [selectedItem, ...filtered]
				: filtered
		const selectedMissing =
			selection.selectedId !== null &&
			status === 'ready' &&
			!pending &&
			!selectedItem
		const lockedPackageId =
			typeof filters.locked === 'string' ? filters.locked : ''
		const shownProviders = filterProviderBindings(
			payload?.providers ?? [],
			filters,
		)
		const packageOptions: Array<ComboboxOption> = [
			{ id: '', label: 'Any package' },
			...packages.map((pkg) => ({
				id: pkg.id,
				label: pkg.kodyId,
				keywords: [pkg.id, pkg.name],
			})),
		]

		return (
			<AccountManagementShell busy={pending && payload !== null}>
				<AccountPageHeader
					title="Credentials"
					description="Keys, OAuth connections, MCP servers, and every other way Kody reaches a service for you. Kody places each value at the network boundary; values never appear here."
					currentHref={currentHref}
					actions={
						<div mix={headerActionsCss}>
							{orgSlug ? (
								<>
									<a
										href={orgCredentialCreatePath(orgSlug)}
										mix={css(getPillButtonCss({ size: 'sm' }))}
									>
										Add credential
									</a>
									<a
										href={orgResourcePath(orgSlug, 'secret-providers')}
										mix={css(getGhostButtonCss({ size: 'sm' }))}
									>
										Secret providers
									</a>
								</>
							) : null}
							<a
								href={docHref('credentials')}
								mix={css(getGhostButtonCss({ size: 'sm' }))}
							>
								How credentials work
							</a>
						</div>
					}
				/>

				{snapshot.error
					? renderCredentialsError({
							message: snapshot.error.message,
							pageUrl,
						})
					: null}

				{selectedMissing
					? renderCredentialsError({
							message:
								'That credential was not found in this org. It may have been deleted, or it belongs to another org.',
							pageUrl,
						})
					: null}

				<RecordTable
					mode="expand"
					ariaLabel="Credentials"
					selectedId={selectedItem ? selectedItem.id : null}
					recordLoading={Boolean(selectedItem && !selectedDetail && pending)}
					record={
						selectedItem
							? renderCredentialDetail({
									credential: selectedItem,
									detail: selectedDetail,
									manageHref: credentialManageHref(selectedItem, {
										orgSlug,
										personalOrgSlug,
									}),
									teamOrg,
									packagesById,
								})
							: undefined
					}
					countLabel={
						status === 'ready'
							? `${shown.length} of ${credentials.length} shown`
							: undefined
					}
					emptyLabel={
						status !== 'ready'
							? 'Loading credentials…'
							: credentials.length === 0
								? shownProviders.length > 0
									? 'No keys, OAuth connections, or MCP servers yet. Your custom secret providers are listed below.'
									: 'No credentials yet. Add a key, connect an OAuth service, or add an MCP server to get started.'
								: 'No credentials match the current filters.'
					}
					toolbar={
						<>
							<RecordTableSearch
								label="Search credentials"
								placeholder="Search credentials"
								value={filters.q ?? ''}
								onInput={(q) =>
									updateFilters((current) => ({
										...current,
										q: q || undefined,
									}))
								}
							/>
							<RecordTableSelect
								label="Filter credentials by kind"
								value={
									filters.kinds?.length === 1
										? (filters.kinds[0] ?? 'all')
										: 'all'
								}
								onChange={(value) =>
									updateFilters((current) => ({
										...current,
										kinds: isCredentialKind(value) ? [value] : undefined,
									}))
								}
							>
								<option value="all">All kinds</option>
								{credentialKinds.map((kind) => (
									<option key={kind} value={kind}>
										{credentialKindLabel(kind)}
									</option>
								))}
							</RecordTableSelect>
							{teamOrg ? (
								<RecordTableSelect
									label="Filter credentials by owner"
									value={filters.scope ?? 'all'}
									onChange={(value) =>
										updateFilters((current) => ({
											...current,
											scope:
												value === 'org' || value === 'personal'
													? value
													: undefined,
										}))
									}
								>
									<option value="all">Org and personal</option>
									<option value="org">Org</option>
									<option value="personal">Personal</option>
								</RecordTableSelect>
							) : null}
							<RecordTableSelect
								label="Filter credentials by package scope"
								value={packageScopeOption(filters)}
								onChange={(value) =>
									updateFilters((current) =>
										packageScopeFilters(
											isPackageScopeOption(value) ? value : 'any',
											current,
										),
									)
								}
							>
								<option value="any">Any package scope</option>
								<option value="scoped">Package-scoped keys</option>
								<option value="unscoped">Not package-scoped</option>
								<option value="locked">Locked to a package</option>
							</RecordTableSelect>
							{packages.length > 0 ? (
								<span mix={css(packageFilterSlotCss)}>
									<Combobox
										key={`credential-package-filter:${lockedPackageId}`}
										id="credential-package-filter"
										label="Filter credentials locked to a package"
										hideLabel
										placeholder="Any package"
										value={lockedPackageId}
										options={packageOptions}
										onChange={(packageId) =>
											updateFilters((current) => ({
												...current,
												locked: packageId || undefined,
											}))
										}
									/>
								</span>
							) : null}
						</>
					}
					columns={[
						{ key: 'name', label: 'Credential', primary: true },
						{ key: 'kind', label: 'Kind' },
						...(teamOrg
							? [{ key: 'owner', label: 'Owner', drop: 2 as const }]
							: []),
						{ key: 'hosts', label: 'Hosts', drop: 1 },
						{ key: 'package', label: 'Packages', drop: 2 },
						{ key: 'status', label: 'Status' },
					]}
					rows={shown.map((credential) => ({
						id: credential.id,
						href:
							credential.id === selection.selectedId
								? credentialsRoute.buildListHref(search, currentHref)
								: credentialsRoute.buildDetailHref(
										credential.id,
										search,
										currentHref,
									),
						cells: {
							name: <span mix={clampedCellCss}>{credential.name}</span>,
							kind: (
								<span mix={clampedCellCss}>{kindCellLabel(credential)}</span>
							),
							owner: scopeLabel(credential),
							hosts: (
								<span mix={clampedCellCss}>{hostsLabel(credential.hosts)}</span>
							),
							package: (
								<span mix={clampedCellCss}>
									{packageLabel(credential, packagesById)}
								</span>
							),
							status: (
								<span
									title={credential.statusMessage ?? undefined}
									mix={css({ color: statusColor(credential) })}
								>
									{credentialStatusLabel(credential.status)}
								</span>
							),
						},
					}))}
				/>

				{shownProviders.length > 0 ? (
					<AccountManagementPanel
						title="Custom secret providers"
						description="Vaults (like 1Password) that resolve secret references when a run needs them. Each is unlocked by a door secret stored in a package."
					>
						<RecordTable
							mode="none"
							ariaLabel="Custom secret providers"
							countLabel={`${shownProviders.length} connected`}
							columns={[
								{ key: 'provider', label: 'Secret provider', primary: true },
								{ key: 'package', label: 'Unlocked by', drop: 1 },
							]}
							rows={shownProviders.map((binding) => ({
								id: binding.id,
								href: orgResourcePath(orgSlug, 'secret-providers'),
								cells: {
									provider: (
										<span mix={clampedCellCss}>
											{binding.provider ?? binding.providerId}
										</span>
									),
									package: (
										<span mix={clampedCellCss}>
											{`${binding.doorSecretName} in ${
												packagesById.get(binding.packageId)?.kodyId ??
												binding.packageId
											}`}
										</span>
									),
								},
							}))}
						/>
					</AccountManagementPanel>
				) : null}
			</AccountManagementShell>
		)
	}
}
