import { formatTimestamp } from '#client/format-timestamp.ts'
import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { navigate, readCurrentRouterHref } from '#client/client-router.tsx'
import { createListDetailRoute } from '#client/list-detail-route.ts'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { replaceLocation } from '#client/replace-location.ts'
import { matchesSearchQuery } from '#client/search-filter.ts'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	AccountManagementLayout,
	AccountManagementList,
	AccountManagementListItemButton,
	AccountManagementMessage,
	AccountManagementSearchField,
	AccountManagementShell,
	AccountManagementSidebar,
	AccountPageHeader,
	MetadataGrid,
} from '#client/routes/account-management-components.tsx'
import { colors, radius, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getDangerButtonCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	inputCss,
	textareaCss,
} from '#client/styles/style-primitives.ts'
import {
	type AccountValueDetail,
	type AccountValueListItem,
	type AccountValuesLoaderData,
} from '#app/loader-data.ts'

type EditorState = {
	name: string
	description: string
	value: string
}

const accountValuesApiPath = '/account/values.json'
const accountValuesPath = '/account/values'
const valuesRoute = createListDetailRoute(accountValuesPath)

/**
 * Selection changes need a refetch for full `selectedValue`. The client-side
 * `q` filter does not change the GET response, so it is omitted from the key.
 */
function getDataLatchKey(href: string) {
	return new URL(href, 'http://localhost').pathname
}

function readSearchFilter(href: string) {
	return new URL(href, 'http://localhost').searchParams.get('q')?.trim() ?? ''
}

function selectionSyncKey(selection: {
	selectedId: string | null
	isCreating: boolean
}) {
	if (selection.isCreating) return 'new'
	if (selection.selectedId) return `id:${selection.selectedId}`
	return 'none'
}

function filterValues(values: Array<AccountValueListItem>, search: string) {
	return values.filter((entry) =>
		matchesSearchQuery(search, [
			entry.name,
			entry.description,
			entry.valuePreview,
		]),
	)
}

function createEmptyEditorState(): EditorState {
	return {
		name: '',
		description: '',
		value: '',
	}
}

function createEditorStateFromDetail(detail: AccountValueDetail): EditorState {
	return {
		name: detail.name,
		description: detail.description,
		value: detail.value,
	}
}

function buildValuesApiRequestUrl(href: string) {
	const selection = valuesRoute.getSelection(href)
	const requestUrl = new URL(accountValuesApiPath, 'http://localhost')
	if (selection.selectedId) {
		requestUrl.searchParams.set('selected', selection.selectedId)
	}
	return `${requestUrl.pathname}${requestUrl.search}`
}

function formatRelativeTtl(ttlMs: number | null) {
	if (ttlMs == null) return 'No expiry'
	const totalMinutes = Math.max(1, Math.round(ttlMs / 60_000))
	if (totalMinutes < 60) return `${totalMinutes}m`
	const hours = Math.floor(totalMinutes / 60)
	const minutes = totalMinutes % 60
	if (hours < 48) {
		return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
	}
	const days = Math.floor(hours / 24)
	return `${days}d`
}

export async function accountValuesRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const href = `${url.pathname}${url.search}`
	const response = await fetch(buildValuesApiRequestUrl(href), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountValuesLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load values.')
	}
	return { accountValues: payload }
}

export function AccountValuesRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let saveState: 'idle' | 'saving' | 'deleting' = 'idle'
	let values: Array<AccountValueListItem> = []
	let selectedValue: AccountValueDetail | null = null
	let editorState = createEmptyEditorState()
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'
	const loadLatch = createRouteLoadLatch()
	let deleteConfirm = false
	let syncedSelectionKey: string | null = null

	const primaryButtonCss = getPrimaryButtonCss()
	const secondaryButtonCss = getSecondaryButtonCss()
	const dangerButtonCss = getDangerButtonCss()

	function getCurrentHref() {
		return readCurrentRouterHref(handle)
	}

	function getCurrentSearch() {
		return new URL(getCurrentHref(), 'http://localhost').search
	}

	function syncRouterLocation(nextPath: string) {
		navigate(nextPath)
	}

	function buildHrefWithUpdatedSearch(search: string) {
		const nextUrl = new URL(getCurrentHref(), 'http://localhost')
		if (search) nextUrl.searchParams.set('q', search)
		else nextUrl.searchParams.delete('q')
		return `${nextUrl.pathname}${nextUrl.search}`
	}

	function setMessage(
		nextMessage: string | null,
		tone: 'info' | 'error' = 'info',
	) {
		message = nextMessage
		messageTone = tone
	}

	function syncEditorToSelection(selection: {
		selectedId: string | null
		isCreating: boolean
	}) {
		const nextKey = selectionSyncKey(selection)
		if (nextKey === syncedSelectionKey) return
		syncedSelectionKey = nextKey
		deleteConfirm = false
		if (selection.isCreating) {
			editorState = createEmptyEditorState()
			selectedValue = null
			return
		}
		if (selection.selectedId) {
			if (selectedValue && selectedValue.id === selection.selectedId) {
				editorState = createEditorStateFromDetail(selectedValue)
				return
			}
			selectedValue = null
			editorState = {
				name: selection.selectedId,
				description: '',
				value: '',
			}
			return
		}
		selectedValue = null
		editorState = createEmptyEditorState()
	}

	function applyPayload(payload: AccountValuesLoaderData) {
		values = payload.values
		selectedValue = payload.selectedValue
		deleteConfirm = false
		if (payload.selectedValue) {
			editorState = createEditorStateFromDetail(payload.selectedValue)
			syncedSelectionKey = selectionSyncKey(
				valuesRoute.getSelection(getCurrentHref()),
			)
			return
		}
		syncedSelectionKey = null
		syncEditorToSelection(valuesRoute.getSelection(getCurrentHref()))
	}

	async function loadValues(signal: AbortSignal) {
		const href = getCurrentHref()
		const latchKey = getDataLatchKey(href)
		try {
			const response = await fetch(buildValuesApiRequestUrl(href), {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (signal.aborted) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<AccountValuesLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load values.')
			}
			if (getDataLatchKey(getCurrentHref()) !== latchKey) return
			applyPayload(payload)
			if (messageTone === 'error') setMessage(null)
			status = 'ready'
			loadLatch.markLoaded(latchKey)
			handle.update()
		} catch (error) {
			if (signal.aborted) return
			status = 'error'
			setMessage(
				error instanceof Error ? error.message : 'Unable to load values.',
				'error',
			)
			loadLatch.markFailed(latchKey)
			handle.update()
		}
	}

	function readEditorStateFromForm(form: HTMLFormElement): EditorState {
		const formData = new FormData(form)
		return {
			name: String(formData.get('name') ?? '').trim(),
			description: String(formData.get('description') ?? '').trim(),
			value: String(formData.get('value') ?? ''),
		}
	}

	async function saveValueEntry(form?: HTMLFormElement) {
		if (saveState !== 'idle') return
		const nextEditorState = form ? readEditorStateFromForm(form) : editorState
		// When editing, the name field is locked; keep the original name even if
		// a stale form submission somehow changes it.
		if (selectedValue) {
			nextEditorState.name = selectedValue.name
		}
		editorState = nextEditorState
		if (!nextEditorState.name.trim()) {
			setMessage('Value name is required.', 'error')
			handle.update()
			return
		}
		if (!nextEditorState.value.trim()) {
			setMessage('Value is required.', 'error')
			handle.update()
			return
		}
		const wasEditing = selectedValue != null
		const previousName = selectedValue?.name ?? null
		saveState = 'saving'
		setMessage(null)
		handle.update()
		try {
			const response = await fetch(accountValuesApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'save',
					name: nextEditorState.name,
					value: nextEditorState.value,
					description: nextEditorState.description,
				}),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AccountValuesLoaderData & { error?: string; ok?: boolean }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to save value.')
			}
			applyPayload(payload)
			saveState = 'idle'
			setMessage(wasEditing ? 'Saved value.' : 'Created value.')
			const nextId = payload.selectedValueId
			if (nextId && (!wasEditing || previousName !== nextId)) {
				syncRouterLocation(
					valuesRoute.buildDetailHref(nextId, getCurrentSearch()),
				)
			}
			handle.update()
		} catch (error) {
			saveState = 'idle'
			setMessage(
				error instanceof Error ? error.message : 'Unable to save value.',
				'error',
			)
			handle.update()
		}
	}

	async function deleteValueEntry() {
		if (!selectedValue || saveState !== 'idle') return
		saveState = 'deleting'
		setMessage(null)
		handle.update()
		try {
			const response = await fetch(accountValuesApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'delete',
					name: selectedValue.name,
				}),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AccountValuesLoaderData & { error?: string; ok?: boolean }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to delete value.')
			}
			applyPayload(payload)
			selectedValue = null
			editorState = createEmptyEditorState()
			syncedSelectionKey = 'none'
			deleteConfirm = false
			saveState = 'idle'
			setMessage('Deleted value.')
			syncRouterLocation(valuesRoute.buildListHref(getCurrentSearch()))
			handle.update()
		} catch (error) {
			saveState = 'idle'
			setMessage(
				error instanceof Error ? error.message : 'Unable to delete value.',
				'error',
			)
			handle.update()
		}
	}

	function selectValue(entry: AccountValueListItem) {
		if (saveState !== 'idle') return
		deleteConfirm = false
		setMessage(null)
		syncRouterLocation(
			valuesRoute.buildDetailHref(entry.id, getCurrentSearch()),
		)
		handle.update()
	}

	function startNewValue() {
		editorState = createEmptyEditorState()
		selectedValue = null
		syncedSelectionKey = 'new'
		deleteConfirm = false
		setMessage(null)
		syncRouterLocation(valuesRoute.buildNewHref(getCurrentSearch()))
		handle.update()
	}

	function resetEditor() {
		const selection = valuesRoute.getSelection(getCurrentHref())
		if (selection.isCreating) {
			editorState = createEmptyEditorState()
		} else if (selectedValue) {
			editorState = createEditorStateFromDetail(selectedValue)
		} else {
			editorState = createEmptyEditorState()
		}
		deleteConfirm = false
		setMessage(null)
		handle.update()
	}

	function applyRouteLoaderData(href: string) {
		if (!valuesRoute.isRoutePath(href)) return false
		const routeData = tryConsumeRouteLoaderData(handle, 'accountValues', href)
		if (!routeData) return false
		applyPayload(routeData)
		status = 'ready'
		loadLatch.markLoaded(getDataLatchKey(href))
		return true
	}

	return () => {
		const currentHref = getCurrentHref()
		const latchKey = getDataLatchKey(currentHref)
		const appliedRouteData = applyRouteLoaderData(currentHref)
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const needsLoad = loadLatch.needsLoad({
			currentHref: latchKey,
			isLoading: status === 'loading',
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			handle.queueTask(loadValues)
		}

		const selection = valuesRoute.getSelection(currentHref)
		syncEditorToSelection(selection)
		const search = readSearchFilter(currentHref)
		const filteredValues = filterValues(values, search)
		const isMutating = saveState !== 'idle'
		const detail = selectedValue
		const isEditing = detail != null
		const isLoadingSelection =
			selection.selectedId != null &&
			(detail == null || detail.id !== selection.selectedId) &&
			needsLoad
		const showEditor =
			selection.isCreating ||
			(selection.selectedId != null && detail != null && !isLoadingSelection)
		const showValueNotFound =
			selection.selectedId != null &&
			detail == null &&
			status === 'ready' &&
			!needsLoad
		const selectedLabel = selection.isCreating
			? 'New value'
			: (detail?.name ?? selection.selectedId ?? 'Value')

		const monospaceValueCss = {
			...textareaCss,
			fontFamily: 'monospace',
			fontSize: typography.fontSize.sm,
			minHeight: '10rem',
		}

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Values"
					description="Readable non-secret configuration for your account. Values are available to packages and workflows as user-scoped config."
					currentHref={currentHref}
					actions={
						<button
							type="button"
							disabled={isMutating}
							mix={[on('click', startNewValue), css(primaryButtonCss)]}
						>
							New value
						</button>
					}
				/>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading values...
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage
						tone={
							status === 'error' || messageTone === 'error' ? 'error' : 'info'
						}
					>
						{message}
					</AccountManagementMessage>
				) : null}

				{status === 'ready' ? (
					<AccountManagementLayout
						sidebarWidth="minmax(18rem, 24rem)"
						sidebar={
							<AccountManagementSidebar
								title="Saved values"
								description="User-scoped values only. Integration and OpenAPI bindings are managed elsewhere."
							>
								<AccountManagementSearchField
									label="Search"
									placeholder="Search values"
									value={search}
									onInput={(value) => {
										replaceLocation(buildHrefWithUpdatedSearch(value))
									}}
								/>
								{values.length === 0 ? (
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										No values yet. Create one to get started.
									</p>
								) : filteredValues.length === 0 ? (
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										No values match the current filters.
									</p>
								) : (
									<AccountManagementList>
										{filteredValues.map((entry) => (
											<li key={entry.id}>
												<AccountManagementListItemButton
													active={selection.selectedId === entry.id}
													disabled={isMutating}
													onClick={() => selectValue(entry)}
												>
													<strong>{entry.name}</strong>
													<span
														mix={css({
															color: colors.textMuted,
															fontSize: typography.fontSize.sm,
															fontFamily: 'monospace',
															overflow: 'hidden',
															textOverflow: 'ellipsis',
															whiteSpace: 'nowrap',
														})}
													>
														{entry.valuePreview || entry.description || '—'}
													</span>
												</AccountManagementListItemButton>
											</li>
										))}
									</AccountManagementList>
								)}
							</AccountManagementSidebar>
						}
					>
						{isLoadingSelection ? (
							<p mix={css({ margin: 0, color: colors.textMuted })}>
								Loading value...
							</p>
						) : showEditor ? (
							<form
								method="post"
								noValidate
								mix={[
									on('submit', (event) => {
										event.preventDefault()
										if (event.currentTarget instanceof HTMLFormElement) {
											void saveValueEntry(event.currentTarget)
										}
									}),
									css(cardCss),
								]}
							>
								<div mix={css({ display: 'grid', gap: spacing.xs })}>
									<h2 mix={css(cardTitleCss)}>{selectedLabel}</h2>
									<p mix={css(descriptionCss)}>
										{selection.isCreating
											? 'Create a named value your packages and workflows can read. Names are unique within your user scope.'
											: 'Edit this user-scoped value. The name is fixed; saving updates description and value only.'}
									</p>
								</div>

								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Name</span>
									<input
										name="name"
										type="text"
										value={editorState.name}
										placeholder="preferred-locale"
										disabled={isMutating}
										readOnly={isEditing}
										required
										mix={[
											on('input', (event) => {
												if (isEditing) return
												editorState = {
													...editorState,
													name: event.currentTarget.value,
												}
												handle.update()
											}),
											css({
												...inputCss,
												...(isEditing
													? {
															color: colors.textMuted,
															cursor: 'default',
														}
													: null),
											}),
										]}
									/>
								</label>
								{isEditing ? (
									<p
										mix={css({
											margin: 0,
											color: colors.textMuted,
											fontSize: typography.fontSize.sm,
										})}
									>
										Name cannot be changed after creation. Create a new value to
										use a different name.
									</p>
								) : null}

								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Description</span>
									<input
										name="description"
										type="text"
										value={editorState.description}
										placeholder="Optional description"
										disabled={isMutating}
										mix={[
											on('input', (event) => {
												editorState = {
													...editorState,
													description: event.currentTarget.value,
												}
												handle.update()
											}),
											css(inputCss),
										]}
									/>
								</label>

								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Value</span>
									<textarea
										name="value"
										value={editorState.value}
										placeholder="Readable configuration text"
										disabled={isMutating}
										required
										mix={[
											on('input', (event) => {
												editorState = {
													...editorState,
													value: event.currentTarget.value,
												}
												handle.update()
											}),
											css(monospaceValueCss),
										]}
									/>
								</label>

								{detail ? (
									<MetadataGrid
										items={[
											{
												label: 'Scope',
												value: detail.scope,
											},
											{
												label: 'Created',
												value: formatTimestamp(detail.createdAt),
											},
											{
												label: 'Updated',
												value: formatTimestamp(detail.updatedAt),
											},
											{
												label: 'TTL',
												value: formatRelativeTtl(detail.ttlMs),
											},
										]}
									/>
								) : null}

								<div
									mix={css({
										display: 'flex',
										gap: spacing.sm,
										flexWrap: 'wrap',
									})}
								>
									<button
										type="submit"
										disabled={isMutating}
										mix={css(primaryButtonCss)}
									>
										{saveState === 'saving'
											? 'Saving...'
											: selection.isCreating
												? 'Create value'
												: 'Save value'}
									</button>
									<button
										type="button"
										disabled={isMutating}
										mix={[on('click', resetEditor), css(secondaryButtonCss)]}
									>
										Reset form
									</button>
									{isEditing ? (
										<button
											type="button"
											disabled={isMutating}
											mix={[
												on('click', () => {
													if (!deleteConfirm) {
														deleteConfirm = true
														handle.update()
														return
													}
													void deleteValueEntry()
												}),
												css(dangerButtonCss),
											]}
										>
											{saveState === 'deleting'
												? 'Deleting...'
												: deleteConfirm
													? 'Confirm delete'
													: 'Delete'}
										</button>
									) : null}
								</div>
							</form>
						) : showValueNotFound ? (
							<div mix={css({ ...cardCss, gap: spacing.sm })}>
								<h2
									mix={css({
										margin: 0,
										fontSize: typography.fontSize.lg,
										fontWeight: typography.fontWeight.semibold,
										color: colors.text,
									})}
								>
									Value not found
								</h2>
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									This value does not exist for this account or is managed by
									another settings page.
								</p>
							</div>
						) : (
							<div
								mix={css({
									...cardCss,
									gap: spacing.sm,
									borderRadius: radius.lg,
								})}
							>
								<h2
									mix={css({
										margin: 0,
										fontSize: typography.fontSize.lg,
										fontWeight: typography.fontWeight.semibold,
										color: colors.text,
									})}
								>
									Select a value
								</h2>
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									Pick a value from the list to edit it, or create a new one.
								</p>
							</div>
						)}
					</AccountManagementLayout>
				) : null}
			</AccountManagementShell>
		)
	}
}
