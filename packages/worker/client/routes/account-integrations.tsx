import {
	type AccountIntegrationListItem,
	type AccountIntegrationsLoaderData,
	type AccountOauthAppListItem,
} from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { type Handle, css } from 'remix/ui'
import { navigate, readCurrentRouterHref } from '#client/client-router.tsx'
import { createDoubleCheck } from '#client/double-check.ts'
import { createUndoableAction } from '#client/undoable-action.ts'
import { UndoToast } from '#client/undo-toast.tsx'
import { replaceLocation } from '#client/replace-location.ts'
import {
	type RouteDataSnapshot,
	createRouteData,
	routeDataRedirect,
} from '#client/route-data.tsx'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
} from '#client/routes/account-management-components.tsx'
import { RecordTable, RecordTableSearch } from '#client/routes/record-table.tsx'
import { colors } from '#universal/styles/tokens.ts'
import { primaryLinkCss } from '#universal/styles/style-primitives.ts'
import {
	type IntegrationUsageDraft,
	type IntegrationsSnapshot,
	buildIntegrationHref,
	buildIntegrationsApiHref,
	connectionLabel,
	deletedAppCopy,
	filterOauthApps,
	getDataLatchKey,
	hostFromUrl,
	integrationListId,
	integrationsRoute,
	isBuiltInApp,
	oauthAppTitle,
	postIntegrationsMutation,
	readSearchFilter,
	resolveIntegrationsSelection,
} from '#client/routes/account-integrations-shared.ts'
import {
	renderIntegrationRecord,
	renderNamedProvider,
} from '#client/routes/account-integrations-detail.tsx'
import {
	renderApprovalCard,
	renderIntegrationsSetupSections,
	renderRecordNotFound,
} from '#client/routes/account-integrations-sections.tsx'

export { accountIntegrationsRouteLoader } from '#client/routes/account-integrations-shared.ts'

export function AccountIntegrationsRoute(handle: Handle) {
	let integrations: Array<AccountIntegrationListItem> = []
	let apps: Array<AccountOauthAppListItem> = []
	let savedPackages: Array<{ id: string; kodyId: string }> = []
	let approval: AccountIntegrationsLoaderData['approval'] = null
	let usageDrafts = new Map<string, IntegrationUsageDraft>()
	let usageSavingName: string | null = null
	let approvalSubmitting = false
	let message: string | null = null
	/** Payload last applied to the closure state above. */
	let appliedPayload: AccountIntegrationsLoaderData | null = null
	let appliedError: Error | null = null
	let lastSnapshot: RouteDataSnapshot<AccountIntegrationsLoaderData> | null =
		null
	const integrationsData = createRouteData({
		key: 'accountIntegrations',
		locationKey: getDataLatchKey,
		async load(href, signal) {
			const response = await fetch(buildIntegrationsApiHref(href), {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (response.status === 401) return routeDataRedirect('/login')
			const payload = await readJson<AccountIntegrationsLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load integrations.')
			}
			return payload
		},
	})
	const disconnectChecks = new Map<
		string,
		ReturnType<typeof createDoubleCheck>
	>()
	const deleteAppCheck = createDoubleCheck(handle)
	const undoable = createUndoableAction(handle)
	let holdingOptimisticRemoval = false

	function isHoldingOptimisticRemoval() {
		return Boolean(undoable.pending) || holdingOptimisticRemoval
	}

	function getDisconnectCheck(name: string) {
		const existing = disconnectChecks.get(name)
		if (existing) return existing
		const created = createDoubleCheck(handle)
		disconnectChecks.set(name, created)
		return created
	}

	function snapshotList(): IntegrationsSnapshot {
		return {
			integrations,
			apps,
			href: getCurrentHref(),
		}
	}

	function restoreSnapshot(snapshot: IntegrationsSnapshot) {
		if (handle.signal.aborted) return
		integrations = snapshot.integrations
		apps = snapshot.apps
		message = null
		handle.update()
		if (
			integrationsRoute.isRoutePath(getCurrentHref()) &&
			getCurrentHref() !== snapshot.href
		) {
			navigate(snapshot.href)
		}
	}

	function listHref() {
		return `${routes.accountIntegrations.href()}${getCurrentSearch()}`
	}

	function currentSelectionMissing() {
		return Boolean(
			resolveIntegrationsSelection({
				href: getCurrentHref(),
				apps,
				integrations,
			}).missingKind,
		)
	}

	function finishOptimisticRemoval() {
		holdingOptimisticRemoval = false
		if (currentSelectionMissing()) {
			navigate(listHref())
			return
		}
		handle.update()
	}

	function removeConnectionLocally(name: string) {
		integrations = integrations.filter((entry) => entry.name !== name)
		apps = apps.flatMap((app) => {
			const connections = app.connections.filter(
				(connection) => connection.name !== name,
			)
			if (connections.length === app.connections.length) return [app]
			if (connections.length === 0) return []
			return [
				{
					...app,
					connections,
					connectionCount: connections.length,
				},
			]
		})
	}

	function removeAppLocally(app: AccountOauthAppListItem) {
		const names = new Set(app.connections.map((connection) => connection.name))
		integrations = integrations.filter((entry) => !names.has(entry.name))
		apps = apps.filter(
			(entry) => integrationListId(entry) !== integrationListId(app),
		)
	}

	function usageDraftFor(connection: AccountIntegrationListItem) {
		return (
			usageDrafts.get(connection.name) ?? {
				usageMode:
					connection.usageMode === 'packages'
						? ('packages' as const)
						: ('any' as const),
				allowedPackageIds: [...(connection.allowedPackageIds ?? [])],
			}
		)
	}

	function setUsageDraft(name: string, draft: IntegrationUsageDraft) {
		usageDrafts = new Map(usageDrafts)
		usageDrafts.set(name, draft)
		handle.update()
	}

	async function submitUsage(connection: AccountIntegrationListItem) {
		if (usageSavingName) return
		const draft = usageDraftFor(connection)
		usageSavingName = connection.name
		handle.update()
		try {
			await postIntegrationsMutation({
				action: 'set_usage',
				name: connection.name,
				usageMode: draft.usageMode,
				allowedPackageIds:
					draft.usageMode === 'packages' ? draft.allowedPackageIds : [],
			})
			integrations = integrations.map((entry) =>
				entry.name === connection.name
					? {
							...entry,
							usageMode: draft.usageMode,
							allowedPackageIds:
								draft.usageMode === 'packages' ? draft.allowedPackageIds : [],
						}
					: entry,
			)
			usageDrafts = new Map(usageDrafts)
			usageDrafts.delete(connection.name)
			message = `Updated usage for ${connectionLabel(connection)}.`
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Unable to update integration usage.'
		} finally {
			usageSavingName = null
			handle.update()
		}
	}

	async function submitApproval() {
		if (!approval || approvalSubmitting) return
		approvalSubmitting = true
		handle.update()
		try {
			await postIntegrationsMutation({
				action: 'approve_package',
				name: approval.name,
				packageId: approval.packageId,
			})
			integrations = integrations.map((entry) => {
				if (entry.name !== approval?.name) return entry
				if (entry.usageMode === 'any' || !entry.usageMode) return entry
				const allowed = new Set(entry.allowedPackageIds ?? [])
				allowed.add(approval.packageId)
				return {
					...entry,
					usageMode: 'packages',
					allowedPackageIds: Array.from(allowed),
				}
			})
			approval = approval ? { ...approval, alreadyGranted: true } : approval
			navigate(routes.accountIntegrations.href())
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Unable to approve that package.'
		} finally {
			approvalSubmitting = false
			handle.update()
		}
	}

	async function startDisconnect(connection: {
		name: string
		accountLabel?: string | null
	}) {
		const snapshot = snapshotList()
		removeConnectionLocally(connection.name)
		getDisconnectCheck(connection.name).reset()
		holdingOptimisticRemoval = true
		// Stay on this route element until commit. List/detail are separate
		// Remix routes, so navigating away remounts, commits immediately, and
		// loader data restores the row that was just hidden.
		await undoable.start({
			message: `Disconnected ${connectionLabel(connection)}.`,
			onCommit: async () => {
				try {
					await postIntegrationsMutation({
						action: 'disconnect_connection',
						name: connection.name,
					})
					finishOptimisticRemoval()
				} catch (error) {
					holdingOptimisticRemoval = false
					restoreSnapshot(snapshot)
					message =
						error instanceof Error
							? error.message
							: 'Unable to disconnect that account.'
					handle.update()
				}
			},
			onUndo: () => {
				holdingOptimisticRemoval = false
				restoreSnapshot(snapshot)
			},
		})
	}

	async function startDeleteApp(app: AccountOauthAppListItem) {
		const snapshot = snapshotList()
		const title = oauthAppTitle(app)
		const connectionCount = app.connections.length
		removeAppLocally(app)
		deleteAppCheck.reset()
		holdingOptimisticRemoval = true
		await undoable.start({
			message: deletedAppCopy(title, connectionCount),
			onCommit: async () => {
				try {
					await postIntegrationsMutation({
						action: 'delete_oauth_app',
						appSlug: app.slug,
					})
					finishOptimisticRemoval()
				} catch (error) {
					holdingOptimisticRemoval = false
					restoreSnapshot(snapshot)
					message =
						error instanceof Error
							? error.message
							: 'Unable to delete that integration.'
					handle.update()
				}
			},
			onUndo: () => {
				holdingOptimisticRemoval = false
				restoreSnapshot(snapshot)
			},
		})
	}

	function getCurrentHref() {
		return readCurrentRouterHref(handle)
	}

	function getCurrentSearch() {
		return new URL(getCurrentHref(), 'http://localhost').search
	}

	function buildHrefWithUpdatedSearch(search: string) {
		const nextUrl = new URL(getCurrentHref(), 'http://localhost')
		if (search) nextUrl.searchParams.set('q', search)
		else nextUrl.searchParams.delete('q')
		return `${nextUrl.pathname}${nextUrl.search}`
	}

	function applyRotatedApp(rotatedApp: AccountOauthAppListItem) {
		apps = apps.map((entry) =>
			entry.slug === rotatedApp.slug && !entry.platform ? rotatedApp : entry,
		)
		integrations = integrations.map((entry) =>
			entry.appSlug === rotatedApp.slug && !entry.platform
				? {
						...entry,
						clientId: rotatedApp.clientId,
						hasClientSecret: rotatedApp.hasClientSecret,
						appLabel: rotatedApp.label,
					}
				: entry,
		)
		handle.update()
	}

	function applyPayload(payload: AccountIntegrationsLoaderData) {
		integrations = payload.integrations
		apps = payload.apps ?? []
		savedPackages = payload.savedPackages ?? []
		approval = payload.approval ?? null
		message = null
	}

	return () => {
		const currentHref = getCurrentHref()
		// Hold optimistic list state for the undo window. Do not consume loader
		// data or a stale-refresh, and do not latch a load — all would clobber
		// the removal or block the next fetch after undo.
		const snapshot =
			isHoldingOptimisticRemoval() && lastSnapshot
				? lastSnapshot
				: integrationsData.read(handle, currentHref)
		lastSnapshot = snapshot
		if (snapshot.data && snapshot.data !== appliedPayload) {
			appliedPayload = snapshot.data
			applyPayload(snapshot.data)
		}
		if (snapshot.error && snapshot.error !== appliedError) {
			appliedError = snapshot.error
			message = snapshot.error.message
		}
		const pending = snapshot.kind === 'pending'
		const status: AccountStatus =
			snapshot.kind === 'error'
				? 'error'
				: pending && appliedPayload === null
					? 'loading'
					: 'ready'

		const search = readSearchFilter(currentHref)
		const setupIntro =
			apps.length === 0
				? 'No integrations yet. Pick a service and copy its prompt into your agent — setup takes a few minutes.'
				: 'Add another service: copy a prompt into your agent.'
		const filteredApps = filterOauthApps(apps, search)
		const { selectedApp, highlightedConnectionName, missingKind } =
			resolveIntegrationsSelection({
				href: currentHref,
				apps,
				integrations,
			})
		const showIntegrationNotFound =
			missingKind === 'integration' &&
			status === 'ready' &&
			!isHoldingOptimisticRemoval()
		const showConnectionNotFound =
			missingKind === 'connection' &&
			status === 'ready' &&
			!isHoldingOptimisticRemoval()
		const highlightedConnection = highlightedConnectionName
			? (integrations.find(
					(connection) => connection.name === highlightedConnectionName,
				) ?? null)
			: null

		return (
			<AccountManagementShell busy={pending && appliedPayload !== null}>
				<AccountPageHeader
					title="Integrations"
					description="Services you connect so Kody can use them."
					currentHref={currentHref}
				/>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading integrations…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage
						tone={status === 'error' ? 'error' : 'info'}
					>
						{message}
					</AccountManagementMessage>
				) : null}

				{status === 'ready' && approval
					? renderApprovalCard({
							approval,
							submitting: approvalSubmitting,
							onApprove: () => void submitApproval(),
						})
					: null}

				{status === 'ready' ? (
					<>
						<RecordTable
							mode="expand"
							ariaLabel="Integrations"
							selectedId={selectedApp ? integrationListId(selectedApp) : null}
							recordLoading={Boolean(
								missingKind &&
								!showIntegrationNotFound &&
								!showConnectionNotFound,
							)}
							countLabel={`${filteredApps.length} of ${apps.length} integrations`}
							emptyLabel={
								apps.length === 0
									? 'No integrations yet.'
									: 'No integrations match the current filters.'
							}
							toolbar={
								<RecordTableSearch
									label="Search integrations"
									placeholder="Search names, hosts, or accounts"
									value={search}
									onInput={(value) => {
										replaceLocation(buildHrefWithUpdatedSearch(value))
									}}
								/>
							}
							columns={[
								{ key: 'name', label: 'Integration', primary: true },
								{
									key: 'accounts',
									label: 'Accounts',
									align: 'end',
								},
							]}
							rows={filteredApps.map((app) => ({
								id: integrationListId(app),
								href: buildIntegrationHref(app, getCurrentSearch()),
								cells: {
									name: renderNamedProvider({
										providerKey: app.provider || app.slug,
										label: oauthAppTitle(app),
										logoPath: app.platformLogoPath ?? app.logoPath,
										autoLogoPath: app.autoLogoPath,
										catalogLogoPath: app.catalogLogoPath,
										host: hostFromUrl(app.authorizeUrl ?? app.tokenUrl),
										builtIn: isBuiltInApp(app),
									}),
									accounts: String(app.connectionCount),
								},
							}))}
							record={
								selectedApp
									? renderIntegrationRecord({
											selectedApp,
											integrations,
											apps,
											savedPackages,
											highlightedConnectionName,
											highlightedConnection,
											currentHref,
											currentSearch: getCurrentSearch(),
											deleteAppCheck,
											getDisconnectCheck,
											startDeleteApp,
											startDisconnect,
											usageDraftFor,
											setUsageDraft,
											submitUsage,
											usageSavingName,
											onRotated: applyRotatedApp,
										})
									: showConnectionNotFound
										? renderRecordNotFound('connection')
										: showIntegrationNotFound
											? renderRecordNotFound('integration')
											: null
							}
						/>
					</>
				) : null}

				{status === 'ready'
					? renderIntegrationsSetupSections(setupIntro)
					: null}

				<p mix={css({ margin: 0 })}>
					<a href="/account" mix={css(primaryLinkCss)}>
						Back to account
					</a>
				</p>
				{undoable.pending ? (
					<UndoToast
						message={undoable.pending.message}
						undoLabel={undoable.pending.undoLabel}
						onUndo={() => {
							void undoable.undo()
						}}
					/>
				) : null}
			</AccountManagementShell>
		)
	}
}
