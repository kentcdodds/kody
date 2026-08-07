import { buildAdminEmailHtmlPreviewDocument } from '#client/email-html-preview.ts'
import { formatNullableTimestamp } from '#client/format-timestamp.ts'
import { type Handle, css } from 'remix/ui'
import { Tab, TabList, TabPanel, Tabs } from 'remix/ui/tabs'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { readRouterSearch } from '#client/router-location.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, radius, typography } from '#client/styles/tokens.ts'
import { cardCss } from '#client/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AdminPageHeader,
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'
import {
	RecordTable,
	recordCellClamp,
	recordStampCss,
} from './record-table.tsx'
import { type AdminSystemEmailLoaderData } from '#app/loader-data.ts'

const clampedCellCss = css(recordCellClamp(30))
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'

type PageStatus = 'loading' | 'ready' | 'error'

const adminSystemEmailApiPath = '/admin/system-email.json'

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

function isAdminSystemEmailPath(href: string) {
	return new URL(href, 'http://localhost').pathname === '/admin/system-email'
}
function formatByteCount(value: number) {
	return new Intl.NumberFormat().format(value)
}

function messageHref(messageId: string) {
	return `/admin/system-email?messageId=${encodeURIComponent(messageId)}`
}

export async function adminSystemEmailRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(`${adminSystemEmailApiPath}${url.search}`, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	if (response.status === 403) {
		throw new Error('You do not have permission to view system email.')
	}
	const payload = await readJson<AdminSystemEmailLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load system email.')
	}
	return { adminSystemEmail: payload }
}

export function AdminSystemEmailRoute(handle: Handle) {
	let status: PageStatus = 'loading'
	let data: AdminSystemEmailLoaderData | null = null
	let message: string | null = null
	let loadRequestId = 0
	let lastLoadedHref = ''
	let loadingForHref: string | null = null
	let lastFailedHref: string | null = null

	function applyData(payload: AdminSystemEmailLoaderData, href: string) {
		data = payload
		status = 'ready'
		message = null
		lastLoadedHref = href
		lastFailedHref = null
	}

	async function loadSystemEmail() {
		const href = readCurrentRouterHref(handle)
		loadingForHref = href
		const requestId = ++loadRequestId
		try {
			const response = await fetch(
				`${adminSystemEmailApiPath}${readRouterSearch(handle)}`,
				{
					headers: { Accept: 'application/json' },
					credentials: 'include',
				},
			)
			if (requestId !== loadRequestId) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			if (response.status === 403) {
				status = 'error'
				message = 'You do not have permission to view system email.'
				lastFailedHref = href
				handle.update()
				return
			}
			const payload = await readJson<AdminSystemEmailLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load system email.')
			}
			applyData(payload, href)
			handle.update()
		} catch (error) {
			if (requestId !== loadRequestId) return
			status = 'error'
			message =
				error instanceof Error ? error.message : 'Unable to load system email.'
			lastFailedHref = href
			handle.update()
		} finally {
			if (requestId === loadRequestId) loadingForHref = null
		}
	}

	function applyRouteLoaderData(href: string) {
		if (!isAdminSystemEmailPath(href)) return false
		const routeData = tryConsumeRouteLoaderData(
			handle,
			'adminSystemEmail',
			href,
		)
		if (!routeData) return false
		applyData(routeData, href)
		return true
	}

	let lastSeenHref = ''

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		if (currentHref !== lastSeenHref) {
			lastSeenHref = currentHref
			lastFailedHref = null
		}
		const appliedRouteData = applyRouteLoaderData(currentHref)
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const needsLoad =
			(status === 'loading' ||
				currentHref !== lastLoadedHref ||
				needsStaleRefresh) &&
			currentHref !== lastFailedHref &&
			loadingForHref !== currentHref
		if (!appliedRouteData && needsLoad && typeof document !== 'undefined') {
			status = 'loading'
			loadingForHref = currentHref
			handle.queueTask(loadSystemEmail)
		}

		const totalPages = data
			? Math.max(1, Math.ceil(data.total / data.pageSize))
			: 1
		const selectedMessage = data?.selectedMessage ?? null

		return (
			<AccountManagementShell maxWidth="min(100%, 92rem)">
				<AdminPageHeader
					title="Admin system email"
					description="Operator-owned inboxes for reserved platform addresses. These messages are not user account data."
					currentHref={currentHref}
				/>
				{status === 'loading' && lastLoadedHref === '' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading system email…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage
						tone={status === 'error' ? 'error' : 'info'}
					>
						{message}
					</AccountManagementMessage>
				) : null}
				{data ? (
					<>
						<AccountManagementPanel
							title="System inbox messages"
							description={`Addresses: ${data.systemLocals
								.map((local) => `${local}@<platform domain>`)
								.join(
									', ',
								)}. Retention keeps ${data.limits.retentionDays} days and at most ${data.limits.maxStoredMessages} stored messages.`}
						>
							<RecordTable
								mode="pane"
								busy={status === 'loading'}
								ariaLabel="System inbox messages"
								selectedId={selectedMessage?.id ?? null}
								countLabel={`${data.total} stored`}
								emptyLabel="No system mail has been stored."
								// The message opens in its own panel below rather than in
								// this table's record slot, so the two panels keep the
								// titles and audit-log framing they already carry.
								scrollHeight="32rem"
								columns={[
									{ key: 'subject', label: 'Subject', primary: true },
									{ key: 'inbox', label: 'Inbox' },
									{ key: 'from', label: 'From', drop: 1 },
									{ key: 'bytes', label: 'Bytes', align: 'end', drop: 2 },
									{ key: 'received', label: 'Received' },
								]}
								rows={data.messages.map((systemMessage) => ({
									id: systemMessage.id,
									href: messageHref(systemMessage.id),
									cells: {
										subject: (
											<span mix={clampedCellCss}>
												{systemMessage.subject || '(no subject)'}
											</span>
										),
										inbox: systemMessage.inbox_local_part,
										from: (
											<span mix={clampedCellCss}>
												{systemMessage.from_address ??
													systemMessage.envelope_from ??
													'Unknown'}
											</span>
										),
										bytes: formatByteCount(systemMessage.raw_size),
										received: (
											<span mix={css(recordStampCss)}>
												{formatNullableTimestamp(
													systemMessage.received_at ?? systemMessage.created_at,
													'Unknown',
												)}
											</span>
										),
									},
								}))}
								footer={
									totalPages > 1 ? (
										<p
											mix={css({
												margin: 0,
												textAlign: 'center',
												color: colors.textMuted,
												fontSize: typography.fontSize.xs,
											})}
										>
											Page {data.page} of {totalPages}
										</p>
									) : null
								}
							/>
						</AccountManagementPanel>

						{selectedMessage ? (
							<AccountManagementPanel
								title={`Message: ${selectedMessage.subject || '(no subject)'}`}
								description="Admin reads of message content are audit logged."
							>
								<MetadataGrid
									items={[
										{
											label: 'Inbox',
											value: selectedMessage.inbox_local_part,
										},
										{
											label: 'From',
											value:
												selectedMessage.from_address ??
												selectedMessage.envelope_from ??
												'Unknown',
										},
										{
											label: 'Received',
											value: (
												<TimestampValue
													value={
														selectedMessage.received_at ??
														selectedMessage.created_at
													}
													fallback="Unknown"
												/>
											),
										},
										{
											label: 'To',
											value: selectedMessage.to_addresses.join(', ') || 'None',
										},
										{
											label: 'Reply-To',
											value:
												selectedMessage.reply_to_addresses.join(', ') || 'None',
										},
										{
											label: 'Attachments',
											value: String(selectedMessage.attachments.length),
										},
									]}
								/>
								<section mix={css(cardCss)}>
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
													No text exists in this tab content.
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
							</AccountManagementPanel>
						) : null}
					</>
				) : null}
			</AccountManagementShell>
		)
	}
}
