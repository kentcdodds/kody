import { buildAdminEmailHtmlPreviewDocument } from '#client/email-html-preview.ts'
import { formatNullableTimestamp } from '#client/format-timestamp.ts'
import { css } from 'remix/ui'
import { Tab, TabList, TabPanel, Tabs } from 'remix/ui/tabs'
import { on } from '#client/event-mixin.ts'
import {
	MetadataGrid,
	TimestampValue,
} from '#client/routes/account-management-components.tsx'
import { recordBodyCss } from '#client/routes/record-table.tsx'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getDangerPillCss,
	getGhostButtonCss,
} from '#universal/styles/style-primitives.ts'
import { type createDoubleCheck } from '#client/double-check.ts'
import { type AccountEmailMessageDetail } from '#universal/loader-data.ts'
import {
	type ClassifyState,
	type DeleteState,
	directionLabel,
	messageDate,
	quarantinedBadgeCss,
} from './account-email-shared.ts'

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

export type AccountEmailDetailProps = {
	selectedMessage: AccountEmailMessageDetail
	classifyState: ClassifyState
	deleteState: DeleteState
	deleteCheck: ReturnType<typeof createDoubleCheck>
	onClassify: (classification: 'accepted' | 'quarantined') => void
	onDelete: () => void
}

export function renderAccountEmailDetail(props: AccountEmailDetailProps) {
	const {
		selectedMessage,
		classifyState,
		deleteState,
		deleteCheck,
		onClassify,
		onDelete,
	} = props
	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
	const dangerButtonCss = getDangerPillCss({ size: 'sm' })
	const isMutating = classifyState !== 'idle' || deleteState !== 'idle'

	return (
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
							title={selectedMessage.classification_reason ?? 'Quarantined'}
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
			<div
				mix={css({
					display: 'flex',
					flexWrap: 'wrap',
					gap: spacing.sm,
				})}
			>
				{selectedMessage.direction === 'inbound' ? (
					selectedMessage.classification === 'quarantined' ? (
						<button
							type="button"
							disabled={isMutating}
							mix={[
								on('click', () => {
									onClassify('accepted')
								}),
								css(secondaryButtonCss),
							]}
						>
							{classifyState === 'saving' ? 'Updating…' : 'Not spam'}
						</button>
					) : (
						<button
							type="button"
							disabled={isMutating}
							mix={[
								on('click', () => {
									onClassify('quarantined')
								}),
								css(dangerButtonCss),
							]}
						>
							{classifyState === 'saving' ? 'Updating…' : 'Mark as spam'}
						</button>
					)
				) : null}
				<button
					type="button"
					disabled={isMutating}
					aria-label={
						deleteCheck.doubleCheck
							? `Confirm delete message "${selectedMessage.subject || '(no subject)'}"`
							: `Delete message "${selectedMessage.subject || '(no subject)'}"`
					}
					title={
						deleteCheck.doubleCheck
							? 'Click again to permanently delete this message'
							: 'Delete this message and free a stored-message slot'
					}
					mix={[
						...deleteCheck.getButtonMix({
							on: {
								click: onDelete,
							},
							resetAfterAction: false,
						}),
						css(dangerButtonCss),
					]}
				>
					{deleteState === 'deleting'
						? 'Deleting…'
						: deleteCheck.doubleCheck
							? 'Confirm delete'
							: 'Delete'}
				</button>
			</div>
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
						value: selectedMessage.to_addresses.join(', ') || 'None',
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
						value: selectedMessage.cc_addresses.join(', ') || 'None',
					},
					{
						label: 'Reply-To',
						value: selectedMessage.reply_to_addresses.join(', ') || 'None',
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
								{attachment.content_type ? ` · ${attachment.content_type}` : ''}
								{attachment.size != null ? ` · ${attachment.size} bytes` : ''}
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
							<pre mix={emailBodyPreCss}>{selectedMessage.text_body}</pre>
						) : (
							<p mix={emailBodyEmptyCss}>
								No text body exists for this message.
							</p>
						)}
					</TabPanel>
					<TabPanel name="source">
						{selectedMessage.html_body ? (
							<pre mix={emailBodyPreCss}>{selectedMessage.html_body}</pre>
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
								{formatNullableTimestamp(event.created_at, 'Unknown')}
								{event.provider ? ` · ${event.provider}` : ''}
							</li>
						))}
					</ul>
				</section>
			) : null}
		</div>
	)
}
