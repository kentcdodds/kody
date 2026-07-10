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
	accountManagementTableCellCss,
	accountManagementTableCss,
	accountManagementTableNumericCellCss,
} from './account-management-components.tsx'
import { type AdminSystemEmailLoaderData } from '#app/loader-data.ts'
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

	const tableCss = accountManagementTableCss
	const cellCss = accountManagementTableCellCss
	const numericCellCss = accountManagementTableNumericCellCss

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
				{status === 'loading' ? (
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
							<div mix={css({ overflowX: 'auto' })}>
								<table mix={css(tableCss)}>
									<thead>
										<tr>
											<th mix={css(cellCss)}>Inbox</th>
											<th mix={css(cellCss)}>From</th>
											<th mix={css(cellCss)}>Subject</th>
											<th mix={css(numericCellCss)}>Bytes</th>
											<th mix={css(cellCss)}>Received</th>
										</tr>
									</thead>
									<tbody>
										{data.messages.map((systemMessage) => (
											<tr key={systemMessage.id}>
												<td mix={css(cellCss)}>
													<a href={messageHref(systemMessage.id)}>
														{systemMessage.inbox_local_part}
													</a>
												</td>
												<td mix={css(cellCss)}>
													{systemMessage.from_address ??
														systemMessage.envelope_from ??
														'Unknown'}
												</td>
												<td mix={css(cellCss)}>
													{systemMessage.subject || '(no subject)'}
												</td>
												<td mix={css(numericCellCss)}>
													{formatByteCount(systemMessage.raw_size)}
												</td>
												<td mix={css(cellCss)}>
													{formatNullableTimestamp(
														systemMessage.received_at ??
															systemMessage.created_at,
														'Unknown',
													)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
							{data.messages.length === 0 ? (
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									No system mail has been stored.
								</p>
							) : null}
							{totalPages > 1 ? (
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									Page {data.page} of {totalPages}
								</p>
							) : null}
						</AccountManagementPanel>

						{selectedMessage ? (
							<AccountManagementPanel
								title={`Message: ${selectedMessage.subject || '(no subject)'}`}
								description="Admin reads of message content are audit logged."
							>
								<MetadataGrid
									columns={3}
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
											value: formatNullableTimestamp(
												selectedMessage.received_at ??
													selectedMessage.created_at,
												'Unknown',
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
