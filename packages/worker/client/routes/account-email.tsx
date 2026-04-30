import { type Handle } from 'remix/component'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	inputCss,
	insetCardCss,
	primaryLinkCss,
} from '#client/styles/style-primitives.ts'
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'

type InboxSummary = {
	id: string
	name: string
	description: string
	mode: 'quarantine' | 'accept'
	addresses: Array<string>
}

type PolicySummary = {
	id: string
	inbox_id: string | null
	kind: 'sender' | 'domain' | 'reply_token'
	value: string
	effect: 'allow' | 'quarantine' | 'reject'
	enabled: boolean
}

type MessageSummary = {
	id: string
	subject: string | null
	from_address: string | null
	policy_decision: 'accepted' | 'quarantined' | 'rejected'
	received_at: string | null
	thread_id: string | null
}

type AgentRunSummary = {
	id: string
	status: 'running' | 'completed' | 'limit_reached' | 'failed'
	tool_calls_used: number
	tool_call_limit: number
	trace_url: string | null
	summary: string | null
	stop_reason: string | null
	reply_message_id: string | null
	completed_at: string | null
}

type SelectedMessageDetail = MessageSummary & {
	text_body: string | null
	html_body: string | null
}

type AccountEmailPayload = {
	ok: true
	email: string
	inboxes: Array<InboxSummary>
	policies: Array<PolicySummary>
	messages: Array<MessageSummary>
	selected_message: SelectedMessageDetail | null
	thread_runs: Array<AgentRunSummary>
	selected_run_id: string | null
}

const accountEmailApiPath = '/account/email.json'

export function AccountEmailRoute(handle: Handle) {
	let status: 'loading' | 'ready' | 'error' = 'loading'
	let payload: AccountEmailPayload | null = null
	let errorMessage: string | null = null
	let selectedInboxId = ''
	let policyKind: 'sender' | 'domain' = 'sender'
	let policyValue = ''
	let saveState: 'idle' | 'saving' = 'idle'
	let revokeState: string | null = null
	let lastLoadedHref = ''

	async function load(signal?: AbortSignal) {
		try {
			const href =
				typeof window === 'undefined'
					? 'https://example.com/account/email'
					: window.location.href
			lastLoadedHref = href
			const response = await fetch(
				`${accountEmailApiPath}${new URL(href).search}`,
				{
					headers: { Accept: 'application/json' },
					credentials: 'include',
					signal,
				},
			)
			if (signal?.aborted) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const nextPayload = await readJson<AccountEmailPayload>(response)
			if (!response.ok || !nextPayload?.ok) {
				throw new Error('Unable to load account email settings.')
			}
			payload = nextPayload
			status = 'ready'
			errorMessage = null
			handle.update()
		} catch (error) {
			if (signal?.aborted) return
			status = 'error'
			errorMessage =
				error instanceof Error
					? error.message
					: 'Unable to load account email settings.'
			handle.update()
		}
	}

	async function submitPolicy(action: 'approve' | 'revoke', policyId?: string) {
		if (!payload || saveState !== 'idle') return
		saveState = 'saving'
		revokeState = action === 'revoke' ? (policyId ?? null) : null
		errorMessage = null
		handle.update()
		try {
			const response = await fetch(accountEmailApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action,
					inboxId: selectedInboxId || null,
					kind: policyKind,
					value: policyValue,
					policyId,
				}),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const nextPayload = await readJson<AccountEmailPayload>(response)
			if (!response.ok || !nextPayload?.ok) {
				throw new Error('Unable to update approved senders.')
			}
			payload = nextPayload
			policyValue = ''
			saveState = 'idle'
			revokeState = null
			handle.update()
		} catch (error) {
			saveState = 'idle'
			revokeState = null
			errorMessage =
				error instanceof Error
					? error.message
					: 'Unable to update approved senders.'
			handle.update()
		}
	}

	return () => {
		const currentHref =
			typeof window === 'undefined'
				? 'https://example.com/account/email'
				: window.location.href
		if (status === 'loading' || currentHref !== lastLoadedHref) {
			handle.queueTask(load)
		}

		const inboxes = payload?.inboxes ?? []
		const policies = payload?.policies ?? []
		const messages = payload?.messages ?? []
		const selectedMessage = payload?.selected_message ?? null
		const threadRuns = payload?.thread_runs ?? []

		return (
			<section
				css={{
					maxWidth: '72rem',
					margin: '0 auto',
					display: 'grid',
					gap: spacing.xl,
				}}
			>
				<header css={{ display: 'grid', gap: spacing.xs }}>
					<h1
						css={{
							margin: 0,
							fontSize: typography.fontSize.xl,
							fontWeight: typography.fontWeight.semibold,
							color: colors.text,
						}}
					>
						Account email
					</h1>
					<p css={{ margin: 0, color: colors.textMuted }}>
						Approve inbound senders for your inboxes and inspect stored email
						message traces.
					</p>
				</header>

				{status === 'loading' ? (
					<p css={{ margin: 0, color: colors.textMuted }}>
						Loading email settings...
					</p>
				) : null}
				{errorMessage ? (
					<p css={{ margin: 0, color: colors.error }} role="alert">
						{errorMessage}
					</p>
				) : null}

				{payload ? (
					<>
						<section css={cardCss}>
							<h2 css={cardTitleCss}>Approved senders</h2>
							<p css={descriptionCss}>
								Manage approved inbound sender emails and domains per inbox.
							</p>
							<div
								css={{
									display: 'grid',
									gridTemplateColumns:
										'minmax(0, 14rem) minmax(0, 10rem) minmax(0, 1fr) auto',
									gap: spacing.sm,
									alignItems: 'end',
								}}
							>
								<label css={fieldCss}>
									<span css={fieldLabelCss}>Inbox</span>
									<select
										value={selectedInboxId}
										on={{
											change: (event) => {
												selectedInboxId = event.currentTarget.value
												handle.update()
											},
										}}
										css={inputCss}
									>
										<option value="">All inboxes</option>
										{inboxes.map((inbox) => (
											<option key={inbox.id} value={inbox.id}>
												{inbox.name}
											</option>
										))}
									</select>
								</label>
								<label css={fieldCss}>
									<span css={fieldLabelCss}>Policy type</span>
									<select
										value={policyKind}
										on={{
											change: (event) => {
												policyKind = event.currentTarget
													.value as typeof policyKind
												handle.update()
											},
										}}
										css={inputCss}
									>
										<option value="sender">Sender email</option>
										<option value="domain">Sender domain</option>
									</select>
								</label>
								<label css={fieldCss}>
									<span css={fieldLabelCss}>Value</span>
									<input
										type="text"
										value={policyValue}
										placeholder={
											policyKind === 'sender'
												? 'person@example.com'
												: 'example.com'
										}
										on={{
											input: (event) => {
												policyValue = event.currentTarget.value
												handle.update()
											},
										}}
										css={inputCss}
									/>
								</label>
								<button
									type="button"
									disabled={saveState !== 'idle' || !policyValue.trim()}
									on={{ click: () => void submitPolicy('approve') }}
									css={primaryButtonCss}
								>
									Approve
								</button>
							</div>
							<div css={{ display: 'grid', gap: spacing.sm }}>
								{policies.length === 0 ? (
									<p css={{ margin: 0, color: colors.textMuted }}>
										No approved senders yet.
									</p>
								) : (
									policies.map((policy) => (
										<div
											key={policy.id}
											css={{
												...insetCardCss,
												gridTemplateColumns: 'minmax(0, 1fr) auto',
												alignItems: 'center',
											}}
										>
											<div css={{ display: 'grid', gap: spacing.xs }}>
												<strong css={{ color: colors.text }}>
													{policy.value}
												</strong>
												<span css={{ color: colors.textMuted }}>
													{policy.kind === 'sender'
														? 'Sender email'
														: 'Sender domain'}
													{policy.inbox_id
														? ` - ${inboxes.find((inbox) => inbox.id === policy.inbox_id)?.name ?? 'Inbox'}`
														: ' - All inboxes'}
												</span>
											</div>
											<button
												type="button"
												disabled={saveState !== 'idle'}
												on={{
													click: () => void submitPolicy('revoke', policy.id),
												}}
												css={secondaryButtonCss}
											>
												{revokeState === policy.id ? 'Removing...' : 'Remove'}
											</button>
										</div>
									))
								)}
							</div>
						</section>

						<section css={cardCss}>
							<h2 css={cardTitleCss}>Stored inbound messages</h2>
							<p css={descriptionCss}>
								Recent accepted and quarantined inbound messages. Open one from
								a trace link or by selecting it below.
							</p>
							<div css={{ display: 'grid', gap: spacing.sm }}>
								{messages.map((message) => (
									<a
										key={message.id}
										href={`/account/email?selected=${encodeURIComponent(message.id)}`}
										css={{
											...insetCardCss,
											textDecoration: 'none',
											color: colors.text,
										}}
									>
										<strong>{message.subject ?? '(no subject)'}</strong>
										<span css={{ color: colors.textMuted }}>
											{message.from_address ?? 'Unknown sender'} -{' '}
											{message.policy_decision}
										</span>
									</a>
								))}
							</div>
						</section>

						{selectedMessage ? (
							<section css={cardCss}>
								<h2 css={cardTitleCss}>Selected message</h2>
								<div css={{ display: 'grid', gap: spacing.sm }}>
									<div>
										<strong>Subject:</strong>{' '}
										{selectedMessage.subject ?? '(no subject)'}
									</div>
									<div>
										<strong>From:</strong>{' '}
										{selectedMessage.from_address ?? 'Unknown'}
									</div>
									<div>
										<strong>Body:</strong>
										<pre
											css={{
												margin: `${spacing.xs} 0 0`,
												padding: spacing.md,
												borderRadius: '0.75rem',
												backgroundColor: colors.background,
												whiteSpace: 'pre-wrap',
											}}
										>
											{selectedMessage.text_body ??
												selectedMessage.html_body ??
												'(no body)'}
										</pre>
									</div>
								</div>
								<div css={{ display: 'grid', gap: spacing.sm }}>
									<h3 css={{ margin: 0, color: colors.text }}>Agent runs</h3>
									{threadRuns.length === 0 ? (
										<p css={{ margin: 0, color: colors.textMuted }}>
											No agent runs recorded for this thread.
										</p>
									) : (
										threadRuns.map((run) => (
											<div key={run.id} css={insetCardCss}>
												<strong>{run.status}</strong>
												<span css={{ color: colors.textMuted }}>
													{run.tool_calls_used}/{run.tool_call_limit} tool calls
												</span>
												{run.summary ? (
													<p css={{ margin: 0 }}>{run.summary}</p>
												) : null}
												{run.trace_url ? (
													<a href={run.trace_url} css={primaryLinkCss}>
														Open trace link
													</a>
												) : null}
											</div>
										))
									)}
								</div>
							</section>
						) : null}
					</>
				) : null}
			</section>
		)
	}
}

const primaryButtonCss = getPrimaryButtonCss()
const secondaryButtonCss = getSecondaryButtonCss()
