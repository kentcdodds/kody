import { buildAdminEmailHtmlPreviewDocument } from '#client/email-html-preview.ts'
import { formatNullableTimestamp } from '#client/format-timestamp.ts'
import { type Handle, css } from 'remix/ui'
import { Tab, TabList, TabPanel, Tabs } from 'remix/ui/tabs'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createListDetailRoute } from '#client/list-detail-route.ts'
import { replaceLocation } from '#client/replace-location.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
	MetadataGrid,
	TimestampValue,
} from '#client/routes/account-management-components.tsx'
import {
	RecordTable,
	RecordTableSearch,
	RecordTableSelect,
	recordBodyCss,
	recordCellClamp,
	recordStampCss,
} from '#client/routes/record-table.tsx'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	cardCss,
	getDangerPillCss,
	getGhostButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	type AccountEmailLoaderData,
	type AccountEmailMessageDetail,
	type AccountEmailMessageListItem,
} from '#universal/loader-data.ts'

type PageStatus = 'loading' | 'ready' | 'error'
type ClassifyState = 'idle' | 'saving'
type ClassificationFilter = 'all' | 'quarantined'

const accountEmailApiPath = '/account/email.json'
const emailRoute = createListDetailRoute('/account/email')

const quarantinedBadgeCss = {
	display: 'inline-flex',
	alignItems: 'center',
	padding: `0.2rem ${spacing.sm}`,
	borderRadius: radius.md,
	border: `1px solid ${colors.danger}`,
	backgroundColor:
		'color-mix(in srgb, var(--color-danger) 10%, var(--color-surface))',
	color: colors.danger,
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.semibold,
} as const

const emailBodyPreCss = css({
	margin: 0,
	whiteSpace: 'pre-wrap',
	overflowX: 'auto',
})

const emailBodyEmptyCss = css({
	margin: 0,
	color: colors.textMuted,
})

const emailHtmlPreviewIframeCss = css({
	display: 'block',
	width: '100%',
	minHeight: '24rem',
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
	background: colors.surface,
})

const truncatedTextCss = {
	minWidth: 0,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap',
} as const

/**
 * Subjects and addresses are arbitrary length, and a table cell will not
 * shrink below its content, so the clamp lives on a block inside the cell.
 * The subject also carries the quarantine badge: it is the one column that
 * never drops and the one that becomes the card heading, so a warning put
 * anywhere else can vanish at exactly the width where it matters most.
 */
const subjectCellCss = css({
	display: 'inline-flex',
	alignItems: 'center',
	gap: spacing.xs,
	// `min()` for the same reason as `recordCellClamp`: below 620px this sits
	// in a card that can be narrower than the clamp.
	maxWidth: 'min(34ch, 100%)',
	minWidth: 0,
})

const clampedCellCss = css(recordCellClamp(26))

function readSearchQuery(href: string) {
	return new URL(href, 'http://localhost').searchParams.get('q')?.trim() ?? ''
}

function readPage(href: string) {
	const raw = new URL(href, 'http://localhost').searchParams.get('page')
	const parsed = raw ? Number.parseInt(raw, 10) : 1
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

function readClassificationFilter(href: string): ClassificationFilter {
	const raw = new URL(href, 'http://localhost').searchParams
		.get('classification')
		?.trim()
	return raw === 'quarantined' ? 'quarantined' : 'all'
}

/**
 * List window depends on search + page; selection also needs a server fetch
 * for message bodies, so the data key includes the selected message id.
 */
function getDataKey(href: string) {
	const url = new URL(href, 'http://localhost')
	const selectedId = emailRoute.getSelection(href).selectedId ?? ''
	return `${url.pathname}?q=${readSearchQuery(href)}&page=${readPage(href)}&pageSize=${url.searchParams.get('pageSize') ?? ''}&classification=${readClassificationFilter(href)}&selected=${selectedId}`
}

function buildEmailApiRequestUrl(href: string) {
	const url = new URL(href, 'http://localhost')
	const requestUrl = new URL(accountEmailApiPath, 'http://localhost')
	const query = readSearchQuery(href)
	if (query) requestUrl.searchParams.set('q', query)
	const page = url.searchParams.get('page')
	if (page) requestUrl.searchParams.set('page', page)
	const pageSize = url.searchParams.get('pageSize')
	if (pageSize) requestUrl.searchParams.set('pageSize', pageSize)
	const classification = readClassificationFilter(href)
	if (classification !== 'all') {
		requestUrl.searchParams.set('classification', classification)
	}
	const selectedId = emailRoute.getSelection(href).selectedId
	if (selectedId) requestUrl.searchParams.set('selected', selectedId)
	return `${requestUrl.pathname}${requestUrl.search}`
}

export async function accountEmailRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const href = `${url.pathname}${url.search}`
	const response = await fetch(buildEmailApiRequestUrl(href), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountEmailLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load your email inbox.')
	}
	return { accountEmail: payload }
}

function messageDate(message: AccountEmailMessageListItem) {
	return message.received_at ?? message.sent_at ?? message.created_at
}

function statusLabel(message: AccountEmailMessageListItem) {
	if (message.delivery_status) return message.delivery_status
	return message.processing_status
}

function directionLabel(direction: AccountEmailMessageListItem['direction']) {
	return direction === 'outbound' ? 'Outbound' : 'Inbound'
}

function consumeAccountEmailPayload(handle: Handle, href: string) {
	return tryConsumeRouteLoaderData(handle, 'accountEmail', href)
}

export function AccountEmailRoute(handle: Handle) {
	let status: PageStatus = 'loading'
	let data: AccountEmailLoaderData | null = null
	let message: string | null = null
	let messageTone: 'error' | 'info' = 'info'
	let classifyState: ClassifyState = 'idle'
	let loadRequestId = 0
	let lastLoadedDataKey = ''
	let loadingDataKey: string | null = null
	let lastFailedDataKey: string | null = null

	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
	const dangerButtonCss = getDangerPillCss({ size: 'sm' })

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
		nextUrl.searchParams.delete('page')
		return `${nextUrl.pathname}${nextUrl.search}`
	}

	function buildHrefWithPage(page: number) {
		const nextUrl = new URL(getCurrentHref(), 'http://localhost')
		if (page > 1) nextUrl.searchParams.set('page', String(page))
		else nextUrl.searchParams.delete('page')
		return `${nextUrl.pathname}${nextUrl.search}`
	}

	function buildHrefWithClassification(filter: ClassificationFilter) {
		const nextUrl = new URL(getCurrentHref(), 'http://localhost')
		if (filter === 'all') nextUrl.searchParams.delete('classification')
		else nextUrl.searchParams.set('classification', filter)
		nextUrl.searchParams.delete('page')
		return `${nextUrl.pathname}${nextUrl.search}`
	}

	function applyPayload(payload: AccountEmailLoaderData, href: string) {
		data = payload
		const selectedId = emailRoute.getSelection(href).selectedId
		message = !payload.emailVerified
			? payload.verificationMessage
			: selectedId && !payload.selectedMessage
				? 'Message not found.'
				: null
		messageTone =
			!payload.emailVerified || (selectedId && !payload.selectedMessage)
				? 'error'
				: 'info'
		status = 'ready'
		lastLoadedDataKey = getDataKey(href)
		lastFailedDataKey = null
	}

	async function classifySelectedMessage(
		classification: 'accepted' | 'quarantined',
	) {
		const selected = data?.selectedMessage
		if (
			!selected ||
			selected.direction !== 'inbound' ||
			classifyState !== 'idle'
		)
			return
		classifyState = 'saving'
		message = null
		handle.update()
		try {
			const response = await fetch(buildEmailApiRequestUrl(getCurrentHref()), {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'classify',
					message_id: selected.id,
					classification,
				}),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AccountEmailLoaderData & { error?: string; ok?: boolean }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(
					payload?.error || 'Unable to update message classification.',
				)
			}
			applyPayload(payload, getCurrentHref())
			classifyState = 'idle'
			message =
				classification === 'quarantined'
					? 'Marked as spam.'
					: 'Marked as not spam.'
			messageTone = 'info'
			handle.update()
		} catch (error) {
			classifyState = 'idle'
			message =
				error instanceof Error
					? error.message
					: 'Unable to update message classification.'
			messageTone = 'error'
			handle.update()
		}
	}

	async function loadAccountEmail() {
		const href = getCurrentHref()
		const dataKey = getDataKey(href)
		loadingDataKey = dataKey
		const requestId = ++loadRequestId
		try {
			const response = await fetch(buildEmailApiRequestUrl(href), {
				headers: { Accept: 'application/json' },
				credentials: 'include',
			})
			if (
				requestId !== loadRequestId ||
				getDataKey(getCurrentHref()) !== dataKey
			)
				return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<AccountEmailLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load your email inbox.')
			}
			applyPayload(payload, href)
			handle.update()
		} catch (error) {
			if (
				requestId !== loadRequestId ||
				getDataKey(getCurrentHref()) !== dataKey
			)
				return
			status = 'error'
			message =
				error instanceof Error
					? error.message
					: 'Unable to load your email inbox.'
			messageTone = 'error'
			lastFailedDataKey = dataKey
			handle.update()
		} finally {
			if (requestId === loadRequestId && loadingDataKey === dataKey) {
				loadingDataKey = null
			}
		}
	}

	function applyRouteLoaderData(href: string) {
		if (!emailRoute.isRoutePath(href)) return false
		const routeData = consumeAccountEmailPayload(handle, href)
		if (!routeData) return false
		applyPayload(routeData, href)
		return true
	}

	let lastSeenDataKey = ''

	return () => {
		const currentHref = getCurrentHref()
		const currentDataKey = getDataKey(currentHref)
		if (currentDataKey !== lastSeenDataKey) {
			lastSeenDataKey = currentDataKey
			lastFailedDataKey = null
		}
		const appliedRouteData = applyRouteLoaderData(currentHref)
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const needsLoad =
			(status === 'loading' ||
				currentDataKey !== lastLoadedDataKey ||
				needsStaleRefresh) &&
			currentDataKey !== lastFailedDataKey &&
			loadingDataKey !== currentDataKey
		if (!appliedRouteData && needsLoad && typeof document !== 'undefined') {
			status = 'loading'
			loadingDataKey = currentDataKey
			handle.queueTask(loadAccountEmail)
		}

		const selectedMessageId = emailRoute.getSelection(currentHref).selectedId
		const selectedMessage: AccountEmailMessageDetail | null =
			data?.selectedMessage ?? null
		const totalPages = data
			? Math.max(1, Math.ceil(data.total / data.pageSize))
			: 1
		const currentPage = data?.page ?? readPage(currentHref)
		const searchQuery = data?.query ?? readSearchQuery(currentHref)
		const classificationFilter =
			data?.classification === 'quarantined'
				? 'quarantined'
				: readClassificationFilter(currentHref)
		const showUnverified = data != null && !data.emailVerified

		return (
			<AccountManagementShell maxWidth="min(100%, 92rem)">
				<AccountPageHeader
					title="Email inbox"
					description="Browse inbound and outbound messages for your platform email address. Compose and reply through Kody agents."
					currentHref={currentHref}
				/>
				{status === 'loading' && lastLoadedDataKey === '' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading email inbox…
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
				{data && !showUnverified ? (
					<>
						{data.usage || data.inboxAddress ? (
							<div
								mix={css({
									display: 'grid',
									gap: spacing.sm,
									marginBottom: spacing.md,
								})}
							>
								{data.inboxAddress ? (
									<p mix={css({ margin: 0, color: colors.text })}>
										Inbox address:{' '}
										<code mix={css({ overflowWrap: 'anywhere' })}>
											{data.inboxAddress}
										</code>
									</p>
								) : null}
								{data.usage ? (
									<p
										mix={css({
											margin: 0,
											color: colors.textMuted,
											fontSize: typography.fontSize.sm,
										})}
									>
										Plan {data.usage.plan}: {data.usage.stored_messages.count}/
										{data.usage.stored_messages.limit} stored ·{' '}
										{data.usage.receives_today.count}/
										{data.usage.receives_today.limit} received today ·{' '}
										{data.usage.sends_today.count}/
										{data.usage.sends_today.limit} sent today
									</p>
								) : null}
							</div>
						) : null}
						<RecordTable
							mode="expand"
							busy={status === 'loading'}
							ariaLabel="Inbox messages"
							selectedId={selectedMessageId}
							countLabel={
								status === 'ready'
									? `${data.total} ${data.total === 1 ? 'message' : 'messages'}`
									: undefined
							}
							emptyLabel={
								searchQuery || classificationFilter !== 'all'
									? 'No messages match the current filters.'
									: 'No messages in your inbox yet.'
							}
							toolbar={
								<>
									<RecordTableSearch
										label="Search messages"
										placeholder="Search subject or from"
										value={searchQuery}
										onInput={(value) => {
											replaceLocation(buildHrefWithUpdatedSearch(value))
										}}
									/>
									<RecordTableSelect
										label="Filter messages by classification"
										value={classificationFilter}
										onChange={(value) => {
											replaceLocation(
												buildHrefWithClassification(
													value === 'quarantined' ? 'quarantined' : 'all',
												),
											)
										}}
									>
										<option value="all">All messages</option>
										<option value="quarantined">Quarantined</option>
									</RecordTableSelect>
								</>
							}
							columns={[
								{ key: 'subject', label: 'Subject', primary: true },
								{ key: 'from', label: 'From', drop: 1 },
								{ key: 'direction', label: 'Direction', drop: 3 },
								{ key: 'status', label: 'Status', drop: 2 },
								{ key: 'date', label: 'Date' },
							]}
							rows={data.messages.map((emailMessage) => ({
								id: emailMessage.id,
								href: emailRoute.buildDetailHref(
									emailMessage.id,
									getCurrentSearch(),
								),
								cells: {
									subject: (
										<span mix={subjectCellCss}>
											<span mix={css(truncatedTextCss)}>
												{emailMessage.subject || '(no subject)'}
											</span>
											{emailMessage.classification === 'quarantined' ? (
												<span
													title={
														emailMessage.classification_reason ?? 'Quarantined'
													}
													mix={css(quarantinedBadgeCss)}
												>
													Quarantined
												</span>
											) : null}
										</span>
									),
									from: (
										<span mix={clampedCellCss}>
											{emailMessage.from_address ??
												emailMessage.envelope_from ??
												'Unknown sender'}
										</span>
									),
									direction: directionLabel(emailMessage.direction),
									status: statusLabel(emailMessage),
									date: (
										<span mix={css(recordStampCss)}>
											{formatNullableTimestamp(
												messageDate(emailMessage),
												'Unknown',
											)}
										</span>
									),
								},
							}))}
							footer={
								totalPages > 1 ? (
									<div
										mix={css({
											display: 'flex',
											gap: spacing.sm,
											alignItems: 'center',
											justifyContent: 'center',
										})}
									>
										<button
											type="button"
											disabled={currentPage <= 1}
											mix={[
												on('click', () => {
													replaceLocation(buildHrefWithPage(currentPage - 1))
												}),
												css(secondaryButtonCss),
											]}
										>
											Previous
										</button>
										<p
											mix={css({
												margin: 0,
												color: colors.textMuted,
												fontSize: typography.fontSize.xs,
											})}
										>
											Page {currentPage} of {totalPages}
										</p>
										<button
											type="button"
											disabled={currentPage >= totalPages}
											mix={[
												on('click', () => {
													replaceLocation(buildHrefWithPage(currentPage + 1))
												}),
												css(secondaryButtonCss),
											]}
										>
											Next
										</button>
									</div>
								) : null
							}
							record={
								selectedMessage ? (
									<div mix={css(recordBodyCss)}>
										<div mix={css({ display: 'grid', gap: spacing.xs })}>
											<div
												mix={css({
													display: 'flex',
													flexWrap: 'wrap',
													gap: spacing.sm,
													alignItems: 'center',
												})}
											>
												<h2
													mix={css({
														margin: 0,
														fontSize: typography.fontSize.lg,
														fontWeight: typography.fontWeight.semibold,
														color: colors.text,
														overflowWrap: 'anywhere',
													})}
												>
													{selectedMessage.subject || '(no subject)'}
												</h2>
												{selectedMessage.classification === 'quarantined' ? (
													<span
														title={
															selectedMessage.classification_reason ??
															'Quarantined'
														}
														mix={css(quarantinedBadgeCss)}
													>
														Quarantined
													</span>
												) : null}
											</div>
											<p mix={css({ margin: 0, color: colors.textMuted })}>
												{directionLabel(selectedMessage.direction)} message
											</p>
											{selectedMessage.classification === 'quarantined' &&
											selectedMessage.classification_reason ? (
												<p
													mix={css({
														margin: 0,
														color: colors.textMuted,
														fontSize: typography.fontSize.sm,
													})}
												>
													{selectedMessage.classification_reason}
												</p>
											) : null}
										</div>
										{selectedMessage.direction === 'inbound' ? (
											<div
												mix={css({
													display: 'flex',
													flexWrap: 'wrap',
													gap: spacing.sm,
												})}
											>
												{selectedMessage.classification === 'quarantined' ? (
													<button
														type="button"
														disabled={classifyState !== 'idle'}
														mix={[
															on('click', () => {
																void classifySelectedMessage('accepted')
															}),
															css(secondaryButtonCss),
														]}
													>
														{classifyState === 'saving'
															? 'Updating…'
															: 'Not spam'}
													</button>
												) : (
													<button
														type="button"
														disabled={classifyState !== 'idle'}
														mix={[
															on('click', () => {
																void classifySelectedMessage('quarantined')
															}),
															css(dangerButtonCss),
														]}
													>
														{classifyState === 'saving'
															? 'Updating…'
															: 'Mark as spam'}
													</button>
												)}
											</div>
										) : null}
										<MetadataGrid
											items={[
												{
													label: 'From',
													value:
														selectedMessage.from_address ??
														selectedMessage.envelope_from ??
														'Unknown',
												},
												{
													label: 'To',
													value:
														selectedMessage.to_addresses.join(', ') || 'None',
												},
												{
													label: 'Date',
													value: (
														<TimestampValue
															value={messageDate(selectedMessage)}
															fallback="Unknown"
														/>
													),
												},
												{
													label: 'Direction',
													value: directionLabel(selectedMessage.direction),
												},
												{
													label: 'Processing',
													value: selectedMessage.processing_status,
												},
												{
													label: 'Delivery',
													value: selectedMessage.delivery_status ?? 'None',
												},
												{
													label: 'Classification',
													value: selectedMessage.classification,
												},
												{
													label: 'CC',
													value:
														selectedMessage.cc_addresses.join(', ') || 'None',
												},
												{
													label: 'Reply-To',
													value:
														selectedMessage.reply_to_addresses.join(', ') ||
														'None',
												},
												{
													label: 'Attachments',
													value: String(selectedMessage.attachments.length),
												},
											]}
										/>
										{selectedMessage.attachments.length > 0 ? (
											<section mix={css({ display: 'grid', gap: spacing.sm })}>
												<h3
													mix={css({
														margin: 0,
														fontSize: typography.fontSize.base,
													})}
												>
													Attachments
												</h3>
												<ul
													mix={css({
														margin: 0,
														paddingLeft: spacing.lg,
														display: 'grid',
														gap: spacing.xs,
													})}
												>
													{selectedMessage.attachments.map((attachment) => (
														<li key={attachment.id}>
															{attachment.filename || '(unnamed)'}
															{attachment.content_type
																? ` · ${attachment.content_type}`
																: ''}
															{attachment.size != null
																? ` · ${attachment.size} bytes`
																: ''}
														</li>
													))}
												</ul>
											</section>
										) : null}
										<section mix={css({ display: 'grid', gap: spacing.sm })}>
											<h3
												mix={css({
													margin: 0,
													fontSize: typography.fontSize.base,
												})}
											>
												Message body
											</h3>
											<Tabs defaultActiveTab="html">
												<TabList aria-label="Email body">
													<Tab name="html">HTML</Tab>
													<Tab name="text">Text</Tab>
													<Tab name="source">HTML Source</Tab>
												</TabList>
												<TabPanel name="html">
													{selectedMessage.html_body ? (
														<iframe
															title="Email HTML preview"
															sandbox=""
															referrerPolicy="no-referrer"
															srcdoc={buildAdminEmailHtmlPreviewDocument(
																selectedMessage.html_body,
															)}
															mix={emailHtmlPreviewIframeCss}
														/>
													) : (
														<p mix={emailBodyEmptyCss}>
															No HTML body exists for this message.
														</p>
													)}
												</TabPanel>
												<TabPanel name="text">
													{selectedMessage.text_body ? (
														<pre mix={emailBodyPreCss}>
															{selectedMessage.text_body}
														</pre>
													) : (
														<p mix={emailBodyEmptyCss}>
															No text body exists for this message.
														</p>
													)}
												</TabPanel>
												<TabPanel name="source">
													{selectedMessage.html_body ? (
														<pre mix={emailBodyPreCss}>
															{selectedMessage.html_body}
														</pre>
													) : (
														<p mix={emailBodyEmptyCss}>
															No HTML body exists for this message.
														</p>
													)}
												</TabPanel>
											</Tabs>
										</section>
										{selectedMessage.delivery_events.length > 0 ? (
											<section mix={css({ display: 'grid', gap: spacing.sm })}>
												<h3
													mix={css({
														margin: 0,
														fontSize: typography.fontSize.base,
													})}
												>
													Delivery events
												</h3>
												<ul
													mix={css({
														margin: 0,
														paddingLeft: spacing.lg,
														display: 'grid',
														gap: spacing.xs,
													})}
												>
													{selectedMessage.delivery_events.map((event) => (
														<li key={event.id}>
															{event.event_type} ·{' '}
															{formatNullableTimestamp(
																event.created_at,
																'Unknown',
															)}
															{event.provider ? ` · ${event.provider}` : ''}
														</li>
													))}
												</ul>
											</section>
										) : null}
									</div>
								) : null
							}
						/>
					</>
				) : null}
				{data && showUnverified ? (
					<div mix={css({ ...cardCss, gap: spacing.sm })}>
						{data.inboxAddress ? (
							<p mix={css({ margin: 0 })}>
								Your inbox address will be <code>{data.inboxAddress}</code>{' '}
								after verification.
							</p>
						) : null}
						<p mix={css({ margin: 0, color: colors.textMuted })}>
							Verify your account email to browse stored messages.
						</p>
					</div>
				) : null}
			</AccountManagementShell>
		)
	}
}
