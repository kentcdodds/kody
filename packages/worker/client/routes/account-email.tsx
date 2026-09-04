import { formatNullableTimestamp } from '#client/format-timestamp.ts'
import { type Handle, css } from 'remix/ui'
import { readAppSession } from '#client/app-session-context.tsx'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { replaceLocation } from '#client/replace-location.ts'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { acceptedEmailVerificationDelivery } from '#universal/email-verification-delivery.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
} from '#client/routes/account-management-components.tsx'
import {
	renderEmailVerificationPrompt,
	requestResendVerification,
} from '#client/routes/email-verification-prompt.tsx'
import {
	RecordTable,
	RecordTableSearch,
	RecordTableSelect,
	recordStampCss,
} from '#client/routes/record-table.tsx'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { getGhostButtonCss } from '#universal/styles/style-primitives.ts'
import {
	type AccountEmailLoaderData,
	type AccountEmailMessageDetail,
} from '#universal/loader-data.ts'
import { renderAccountEmailDetail } from './account-email-detail.tsx'
import {
	type ClassificationFilter,
	type ClassifyState,
	type PageStatus,
	accountEmailRouteLoader,
	buildEmailApiRequestUrl,
	clampedCellCss,
	consumeAccountEmailPayload,
	directionLabel,
	emailRoute,
	getDataKey,
	messageDate,
	quarantinedBadgeCss,
	readClassificationFilter,
	readPage,
	readSearchQuery,
	statusLabel,
	subjectCellCss,
	truncatedTextCss,
} from './account-email-shared.ts'

export { accountEmailRouteLoader }

export function AccountEmailRoute(handle: Handle) {
	let status: PageStatus = 'loading'
	let data: AccountEmailLoaderData | null = null
	let message: string | null = null
	let messageTone: 'error' | 'info' = 'info'
	let classifyState: ClassifyState = 'idle'
	let resendStatus: 'idle' | 'sending' = 'idle'
	let resendMessage: string | null = null
	let resendTone: 'error' | 'info' = 'info'
	let resendAccepted = false
	let loadRequestId = 0
	let lastLoadedDataKey = ''
	let loadingDataKey: string | null = null
	let lastFailedDataKey: string | null = null

	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })

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
		message =
			payload.emailVerified && selectedId && !payload.selectedMessage
				? 'Message not found.'
				: null
		messageTone = selectedId && !payload.selectedMessage ? 'error' : 'info'
		status = 'ready'
		lastLoadedDataKey = getDataKey(href)
		lastFailedDataKey = null
	}

	async function handleResendVerification() {
		resendStatus = 'sending'
		resendMessage = null
		resendTone = 'info'
		handle.update()

		try {
			const result = await requestResendVerification()
			if (!result.ok && result.unauthorized) {
				window.location.assign('/login')
				return
			}
			resendTone = result.ok ? 'info' : 'error'
			resendMessage = result.message
			if (result.ok) {
				resendAccepted = true
			}
		} catch {
			resendTone = 'error'
			resendMessage = 'Unable to send the verification email.'
		} finally {
			resendStatus = 'idle'
			handle.update()
		}
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
										<span mix={css(subjectCellCss)}>
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
										<span mix={css(clampedCellCss)}>
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
								selectedMessage
									? renderAccountEmailDetail({
											selectedMessage,
											classifyState,
											onClassify: (classification) => {
												void classifySelectedMessage(classification)
											},
										})
									: null
							}
						/>
					</>
				) : null}
				{data && showUnverified ? (
					<>
						{data.inboxAddress ? (
							<p mix={css({ margin: 0 })}>
								Your inbox address will be <code>{data.inboxAddress}</code>{' '}
								after verification.
							</p>
						) : null}
						{renderEmailVerificationPrompt({
							email: data.email,
							description:
								'Verify your account email to browse stored messages. MCP access and email features stay locked until this account email is verified.',
							delivery: resendAccepted
								? acceptedEmailVerificationDelivery()
								: (readAppSession(handle)?.session?.emailVerificationDelivery ??
									null),
							resendStatus,
							resendMessage,
							resendTone,
							onResend: () => {
								void handleResendVerification()
							},
							secondaryHref: '/pending-verification',
							secondaryLabel: 'Verification page',
						})}
					</>
				) : null}
			</AccountManagementShell>
		)
	}
}
