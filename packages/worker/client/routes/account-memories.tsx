import { formatTimestamp } from '#client/format-timestamp.ts'
import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { navigate, readCurrentRouterHref } from '#client/client-router.tsx'
import { createListDetailRoute } from '#client/list-detail-route.ts'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { replaceLocation } from '#client/replace-location.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	type AccountMemoryDetail,
	type AccountMemoryListItem,
	type AccountMemoriesLoaderData,
} from '#app/loader-data.ts'
import { matchesSearchQuery } from '#client/search-filter.ts'
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
	getDangerPillCss,
	getGhostButtonCss,
} from '#client/styles/style-primitives.ts'

const accountMemoriesApiPath = '/account/memories.json'
const memoriesRoute = createListDetailRoute('/account/memories')

type MessageTone = 'info' | 'error'
type DeleteMode = 'soft' | 'hard' | null

/**
 * Latch key for the GET payload. Selection, `includeDeleted`, and `q` all
 * affect which memories are returned or which detail is hydrated.
 */
function getDataLatchKey(href: string) {
	const includeDeleted = readIncludeDeleted(href)
	const search = readSearchFilter(href)
	const selectedId = memoriesRoute.getSelection(href).selectedId ?? ''
	return `/account/memories?includeDeleted=${includeDeleted ? '1' : '0'}&q=${search}&selected=${selectedId}`
}

function readSearchFilter(href: string) {
	return new URL(href, 'http://localhost').searchParams.get('q')?.trim() ?? ''
}

function readIncludeDeleted(href: string) {
	const raw = new URL(href, 'http://localhost').searchParams
		.get('includeDeleted')
		?.trim()
		.toLowerCase()
	return raw === '1' || raw === 'true' || raw === 'yes'
}

function filterMemories(
	memories: Array<AccountMemoryListItem>,
	search: string,
) {
	return memories.filter((memory) =>
		matchesSearchQuery(search, [
			memory.subject,
			memory.category,
			memory.status,
			memory.summary,
			...memory.tags,
		]),
	)
}

function buildMemoriesApiRequestUrl(href: string) {
	const requestUrl = new URL(accountMemoriesApiPath, 'http://localhost')
	const search = readSearchFilter(href)
	if (search) requestUrl.searchParams.set('q', search)
	if (readIncludeDeleted(href)) {
		requestUrl.searchParams.set('includeDeleted', 'true')
	}
	const selectedId = memoriesRoute.getSelection(href).selectedId
	if (selectedId) requestUrl.searchParams.set('selected', selectedId)
	return `${requestUrl.pathname}${requestUrl.search}`
}

export async function accountMemoriesRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(buildMemoriesApiRequestUrl(url.href), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountMemoriesLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load memories.')
	}
	return { accountMemories: payload }
}

function statusLabel(status: AccountMemoryListItem['status']) {
	switch (status) {
		case 'active':
			return 'Active'
		case 'archived':
			return 'Archived'
		case 'deleted':
			return 'Deleted'
		default:
			status satisfies never
			return 'Unknown'
	}
}

function statusColor(status: AccountMemoryListItem['status']) {
	switch (status) {
		case 'active':
			return colors.primary
		case 'archived':
			return colors.textMuted
		case 'deleted':
			return colors.error
		default:
			status satisfies never
			return colors.textMuted
	}
}

function formatOptional(value: string | null | undefined) {
	return value?.trim() ? value : '—'
}

export function AccountMemoriesRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let actionState: 'idle' | 'busy' = 'idle'
	let memories: Array<AccountMemoryListItem> = []
	let selectedMemory: AccountMemoryDetail | null = null
	let message: string | null = null
	let messageTone: MessageTone = 'info'
	let deleteMode: DeleteMode = null
	const loadLatch = createRouteLoadLatch()

	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
	const dangerButtonCss = getDangerPillCss({ size: 'sm' })

	function getCurrentHref() {
		return readCurrentRouterHref(handle)
	}

	function getCurrentSearch() {
		return new URL(getCurrentHref(), 'http://localhost').search
	}

	function buildHrefWithUpdatedParams(input: {
		search?: string
		includeDeleted?: boolean
	}) {
		const nextUrl = new URL(getCurrentHref(), 'http://localhost')
		const search = input.search ?? readSearchFilter(nextUrl.href)
		const includeDeleted =
			input.includeDeleted ?? readIncludeDeleted(nextUrl.href)
		if (search) nextUrl.searchParams.set('q', search)
		else nextUrl.searchParams.delete('q')
		if (includeDeleted) nextUrl.searchParams.set('includeDeleted', 'true')
		else nextUrl.searchParams.delete('includeDeleted')
		return `${nextUrl.pathname}${nextUrl.search}`
	}

	function setMessage(nextMessage: string | null, tone: MessageTone = 'info') {
		message = nextMessage
		messageTone = tone
	}

	function applyPayload(payload: AccountMemoriesLoaderData) {
		memories = payload.memories
		selectedMemory = payload.selectedMemory
		deleteMode = null
	}

	async function loadMemories(signal: AbortSignal) {
		const href = getCurrentHref()
		const latchKey = getDataLatchKey(href)
		try {
			const response = await fetch(buildMemoriesApiRequestUrl(href), {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (signal.aborted) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<AccountMemoriesLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load memories.')
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
				error instanceof Error ? error.message : 'Unable to load memories.',
				'error',
			)
			loadLatch.markFailed(latchKey)
			handle.update()
		}
	}

	async function postDelete(input: { memoryId: string; force: boolean }) {
		if (actionState !== 'idle') return
		actionState = 'busy'
		setMessage(null)
		handle.update()
		try {
			const response = await fetch(accountMemoriesApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'delete',
					memoryId: input.memoryId,
					force: input.force,
				}),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AccountMemoriesLoaderData & { error?: string; ok?: boolean }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to delete memory.')
			}
			applyPayload(payload)
			actionState = 'idle'
			setMessage(
				input.force ? 'Permanently deleted memory.' : 'Soft-deleted memory.',
			)
			navigate(memoriesRoute.buildListHref(getCurrentSearch()))
			handle.update()
		} catch (error) {
			actionState = 'idle'
			deleteMode = null
			setMessage(
				error instanceof Error ? error.message : 'Unable to delete memory.',
				'error',
			)
			handle.update()
		}
	}

	function applyRouteLoaderData(href: string) {
		if (!memoriesRoute.isRoutePath(href)) return false
		const routeData = tryConsumeRouteLoaderData(handle, 'accountMemories', href)
		if (!routeData) return false
		applyPayload(routeData)
		status = 'ready'
		loadLatch.markLoaded(getDataLatchKey(href))
		return true
	}

	return () => {
		const currentHref = getCurrentHref()
		const appliedRouteData = applyRouteLoaderData(currentHref)
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const latchKey = getDataLatchKey(currentHref)
		const needsLoad = loadLatch.needsLoad({
			currentHref: latchKey,
			isLoading: status === 'loading',
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			handle.queueTask(loadMemories)
		}
		const isMutating = actionState !== 'idle'
		const selection = memoriesRoute.getSelection(currentHref)
		const search = readSearchFilter(currentHref)
		const includeDeleted = readIncludeDeleted(currentHref)
		const filteredMemories = filterMemories(memories, search)
		const detailMemory =
			selectedMemory?.id === selection.selectedId ? selectedMemory : null
		const listMatch =
			memories.find((item) => item.id === selection.selectedId) ?? null
		const waitingForDetail =
			selection.selectedId != null &&
			!detailMemory &&
			(needsLoad || listMatch != null || status === 'loading')
		const showMemoryNotFound =
			selection.selectedId != null &&
			!detailMemory &&
			!waitingForDetail &&
			status === 'ready'

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Memories"
					description="Long-term memories Kody stores for your account. Agents create and update them; you can browse, filter, and delete here."
					currentHref={currentHref}
				/>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading memories...
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
								title="Saved memories"
								description="Select a memory to inspect details, sources, and timestamps. Showing up to 100 most recent memories."
							>
								<AccountManagementSearchField
									label="Search"
									placeholder="Search subject, category, tags, summary"
									value={search}
									onInput={(value) => {
										replaceLocation(
											buildHrefWithUpdatedParams({ search: value }),
										)
									}}
								/>
								<label
									mix={css({
										display: 'flex',
										alignItems: 'center',
										gap: spacing.sm,
										color: colors.textMuted,
										fontSize: typography.fontSize.sm,
									})}
								>
									<input
										type="checkbox"
										checked={includeDeleted}
										disabled={isMutating}
										mix={on('change', (event) => {
											replaceLocation(
												buildHrefWithUpdatedParams({
													includeDeleted: event.currentTarget.checked,
												}),
											)
										})}
									/>
									Include deleted
								</label>
								{memories.length === 0 ? (
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										No memories yet. Agents create them through verify and
										upsert.
									</p>
								) : filteredMemories.length === 0 ? (
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										No memories match the current filters.
									</p>
								) : (
									<AccountManagementList>
										{filteredMemories.map((item) => (
											<li key={item.id} mix={css({ minWidth: 0 })}>
												<AccountManagementListItemButton
													active={selection.selectedId === item.id}
													disabled={isMutating}
													onClick={() => {
														if (isMutating) return
														deleteMode = null
														setMessage(null)
														navigate(
															memoriesRoute.buildDetailHref(
																item.id,
																getCurrentSearch(),
															),
														)
													}}
												>
													<strong
														mix={css({
															minWidth: 0,
															overflowWrap: 'anywhere',
														})}
													>
														{item.subject}
													</strong>
													<span
														mix={css({
															color: statusColor(item.status),
															fontSize: typography.fontSize.sm,
														})}
													>
														{statusLabel(item.status)}
														{item.category ? ` · ${item.category}` : ''}
													</span>
													{item.tags.length > 0 ? (
														<span
															mix={css({
																color: colors.textMuted,
																fontSize: typography.fontSize.sm,
																overflowWrap: 'anywhere',
															})}
														>
															{item.tags.join(', ')}
														</span>
													) : null}
													<span
														mix={css({
															color: colors.textMuted,
															fontSize: typography.fontSize.sm,
															overflowWrap: 'anywhere',
														})}
													>
														{item.summary}
													</span>
												</AccountManagementListItemButton>
											</li>
										))}
									</AccountManagementList>
								)}
							</AccountManagementSidebar>
						}
					>
						{detailMemory ? (
							<section mix={css(cardCss)}>
								<div mix={css({ display: 'grid', gap: spacing.xs })}>
									<h2 mix={css(cardTitleCss)}>{detailMemory.subject}</h2>
									<p mix={css(descriptionCss)}>{detailMemory.summary}</p>
								</div>

								<MetadataGrid
									items={[
										{
											label: 'Status',
											value: (
												<span
													mix={css({ color: statusColor(detailMemory.status) })}
												>
													{statusLabel(detailMemory.status)}
												</span>
											),
										},
										{
											label: 'Category',
											value: formatOptional(detailMemory.category),
										},
										{
											label: 'Tags',
											value:
												detailMemory.tags.length > 0
													? detailMemory.tags.join(', ')
													: '—',
										},
										{
											label: 'Dedupe key',
											value: formatOptional(detailMemory.dedupeKey),
										},
										{
											label: 'Created',
											value: formatTimestamp(detailMemory.createdAt),
										},
										{
											label: 'Updated',
											value: formatTimestamp(detailMemory.updatedAt),
										},
										{
											label: 'Last accessed',
											value: detailMemory.lastAccessedAt
												? formatTimestamp(detailMemory.lastAccessedAt)
												: '—',
										},
										{
											label: 'Deleted',
											value: detailMemory.deletedAt
												? formatTimestamp(detailMemory.deletedAt)
												: '—',
										},
									]}
								/>

								<div mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Details</span>
									<p
										mix={css({
											margin: 0,
											padding: spacing.sm,
											borderRadius: radius.md,
											border: `1px solid ${colors.border}`,
											backgroundColor: colors.background,
											color: colors.text,
											whiteSpace: 'pre-wrap',
											overflowWrap: 'anywhere',
										})}
									>
										{detailMemory.details.trim() ? detailMemory.details : '—'}
									</p>
								</div>

								<div mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Source URIs</span>
									{detailMemory.sourceUris.length === 0 ? (
										<p mix={css({ margin: 0, color: colors.textMuted })}>—</p>
									) : (
										<ul
											mix={css({
												margin: 0,
												paddingLeft: spacing.lg,
												display: 'grid',
												gap: spacing.xs,
											})}
										>
											{detailMemory.sourceUris.map((uri) => (
												<li key={uri}>
													<a
														href={uri}
														target="_blank"
														rel="noreferrer"
														mix={css({
															color: colors.primary,
															overflowWrap: 'anywhere',
														})}
													>
														{uri}
													</a>
												</li>
											))}
										</ul>
									)}
								</div>

								<div
									mix={css({
										display: 'flex',
										gap: spacing.sm,
										flexWrap: 'wrap',
										alignItems: 'center',
									})}
								>
									<button
										type="button"
										disabled={isMutating || detailMemory.status === 'deleted'}
										mix={[
											on('click', () => {
												if (deleteMode !== 'soft') {
													deleteMode = 'soft'
													handle.update()
													return
												}
												void postDelete({
													memoryId: detailMemory.id,
													force: false,
												})
											}),
											css(dangerButtonCss),
										]}
									>
										{actionState === 'busy' && deleteMode === 'soft'
											? 'Deleting...'
											: deleteMode === 'soft'
												? 'Confirm soft delete'
												: 'Soft delete'}
									</button>
									<button
										type="button"
										disabled={isMutating}
										mix={[
											on('click', () => {
												if (deleteMode !== 'hard') {
													deleteMode = 'hard'
													handle.update()
													return
												}
												void postDelete({
													memoryId: detailMemory.id,
													force: true,
												})
											}),
											css(dangerButtonCss),
										]}
									>
										{actionState === 'busy' && deleteMode === 'hard'
											? 'Deleting...'
											: deleteMode === 'hard'
												? 'Confirm permanent delete'
												: 'Delete permanently'}
									</button>
									{deleteMode ? (
										<button
											type="button"
											disabled={isMutating}
											mix={[
												on('click', () => {
													deleteMode = null
													handle.update()
												}),
												css(secondaryButtonCss),
											]}
										>
											Cancel
										</button>
									) : null}
								</div>
							</section>
						) : showMemoryNotFound ? (
							<div mix={css({ ...cardCss, gap: spacing.sm })}>
								<h2
									mix={css({
										margin: 0,
										fontSize: typography.fontSize.lg,
										fontWeight: typography.fontWeight.semibold,
										color: colors.text,
									})}
								>
									Memory not found
								</h2>
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									This memory does not exist for this account or is unavailable.
								</p>
							</div>
						) : (
							<div mix={css({ ...cardCss, gap: spacing.sm })}>
								<h2
									mix={css({
										margin: 0,
										fontSize: typography.fontSize.lg,
										fontWeight: typography.fontWeight.semibold,
										color: colors.text,
									})}
								>
									Select a memory
								</h2>
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									Pick a memory from the list to inspect its details, sources,
									and timestamps.
								</p>
							</div>
						)}
					</AccountManagementLayout>
				) : null}
			</AccountManagementShell>
		)
	}
}
