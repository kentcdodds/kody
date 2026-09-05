import { css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { type createDoubleCheck } from '#client/double-check.ts'
import { formatTimestamp } from '#client/format-timestamp.ts'
import {
	AccountManagementMessage,
	IdValue,
	MetadataGrid,
	TimestampValue,
} from '#client/routes/account-management-components.tsx'
import { recordBodyCss } from '#client/routes/record-table.tsx'
import { renderHighlightedCode } from '#client/syntax-highlight.tsx'
import { plainHighlightedCode } from '#universal/highlighted-code.ts'
import {
	type AccountJobDetail,
	type AccountJobsLoaderData,
} from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	type PostAccountJobsAction,
	formatDurationMs,
	statusColor,
	statusLabel,
} from '#client/routes/account-jobs-shared.ts'

const primaryButtonCss = getPillButtonCss({ size: 'sm' })
const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
const dangerButtonCss = getDangerPillCss({ size: 'sm' })

function packageValue(
	username: string,
	job: Pick<AccountJobDetail, 'ownership' | 'packageName' | 'packageKodyId'>,
) {
	if (job.ownership !== 'package') return '—'
	if (username && job.packageKodyId && job.packageName) {
		return (
			<a
				href={routes.communityPackage.href({
					username,
					kodyId: job.packageKodyId,
				})}
				mix={css(primaryLinkCss)}
			>
				{job.packageName}
			</a>
		)
	}
	return job.packageName ?? 'Package'
}

export function renderJobDetailPlaceholder(title: string, body: string) {
	return (
		<div mix={css({ ...recordBodyCss, gap: spacing.sm })}>
			<h2
				mix={css({
					margin: 0,
					fontSize: typography.fontSize.lg,
					fontWeight: typography.fontWeight.semibold,
					color: colors.text,
				})}
			>
				{title}
			</h2>
			<p mix={css({ margin: 0, color: colors.textMuted })}>{body}</p>
		</div>
	)
}

export function renderAccountJobDetail(input: {
	username: string
	detail: AccountJobDetail
	isMutating: boolean
	retention: AccountJobsLoaderData['retention']
	deleteJobCheck: ReturnType<typeof createDoubleCheck>
	postAction: PostAccountJobsAction
	navigateToList: () => void
}) {
	const {
		username,
		detail,
		isMutating,
		retention,
		deleteJobCheck,
		postAction,
		navigateToList,
	} = input
	const isPackageOwned = detail.ownership === 'package'
	const isNotPackageOwned = !isPackageOwned
	return (
		<section mix={css(recordBodyCss)}>
			<div mix={css({ display: 'grid', gap: spacing.xs })}>
				<h2 mix={css(cardTitleCss)}>{detail.name}</h2>
				<p mix={css(descriptionCss)}>
					{isPackageOwned
						? 'Package-owned job. Schedule and name are owned by package publish; kill switch and run-now are available here. Use the kill switch to stop it.'
						: 'Scheduled job. You can enable or disable it, Preserve it from auto-cleanup, or delete it.'}
				</p>
			</div>

			<MetadataGrid
				items={[
					{
						label: 'Package',
						value: packageValue(username, detail),
					},
					{
						label: 'Preserve',
						value: detail.preserved ? 'On (never auto-deleted)' : 'Off',
					},
					{
						label: 'Expires',
						value: detail.expiresAt ? (
							<>
								{detail.expired ? 'Expired ' : ''}
								<TimestampValue value={detail.expiresAt} />
							</>
						) : (
							'Never'
						),
					},
					{
						label: 'Status',
						value: (
							<span mix={css({ color: statusColor(detail) })}>
								{statusLabel(detail)}
							</span>
						),
					},
					{
						label: 'Schedule',
						value: detail.scheduleSummary,
					},
					{
						label: 'Timezone',
						value: detail.timezone,
					},
					{
						label: 'Next run',
						value: <TimestampValue value={detail.nextRunAt} />,
					},
					{
						label: 'Last run',
						value: <TimestampValue value={detail.lastRunAt} />,
					},
					{
						label: 'Last duration',
						value: formatDurationMs(detail.lastDurationMs),
					},
					{
						label: 'Runs',
						value: `${detail.runCount} total · ${detail.successCount} ok · ${detail.errorCount} error`,
					},
					{
						label: 'Storage id',
						value: <IdValue value={detail.storageId} label="storage id" />,
					},
					{
						label: 'Source id',
						value: <IdValue value={detail.sourceId} label="source id" />,
					},
					{
						label: 'Published commit',
						value: detail.publishedCommit ? (
							<IdValue
								value={detail.publishedCommit}
								label="published commit"
							/>
						) : (
							'—'
						),
					},
					{
						label: 'Updated',
						value: <TimestampValue value={detail.updatedAt} />,
					},
				]}
			/>

			{detail.lastRunError ? (
				<AccountManagementMessage tone="error">
					{detail.lastRunError}
				</AccountManagementMessage>
			) : null}

			{isPackageOwned ? (
				<p mix={css(descriptionCss)}>
					To change this job&apos;s schedule or name, update the package job
					declaration and publish the package again.
				</p>
			) : null}

			<div mix={css(fieldCss)}>
				<span mix={css(fieldLabelCss)}>Recent runs</span>
				{detail.recentRuns.length === 0 ? (
					<p mix={css({ margin: 0, color: colors.textMuted })}>
						No runs recorded yet.
					</p>
				) : (
					<div
						mix={css({
							overflowX: 'auto',
							border: `1px solid ${colors.border}`,
							borderRadius: radius.md,
						})}
					>
						<table
							mix={css({
								width: '100%',
								borderCollapse: 'collapse',
								fontSize: typography.fontSize.sm,
							})}
						>
							<thead>
								<tr>
									{[
										'Started',
										'Finished',
										'Status',
										'Duration',
										'Error',
										'',
									].map((heading) => (
										<th
											key={heading || 'logs'}
											mix={css({
												textAlign: 'left',
												padding: spacing.sm,
												borderBottom: `1px solid ${colors.border}`,
												color: colors.textMuted,
												fontWeight: typography.fontWeight.medium,
											})}
										>
											{heading}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{detail.recentRuns.map((run) => (
									<tr key={run.id}>
										<td
											mix={css({
												padding: spacing.sm,
												borderBottom: `1px solid ${colors.border}`,
											})}
										>
											{formatTimestamp(run.startedAt)}
										</td>
										<td
											mix={css({
												padding: spacing.sm,
												borderBottom: `1px solid ${colors.border}`,
											})}
										>
											{formatTimestamp(run.finishedAt)}
										</td>
										<td
											mix={css({
												padding: spacing.sm,
												borderBottom: `1px solid ${colors.border}`,
												color:
													run.status === 'error'
														? colors.error
														: run.status === 'running'
															? colors.textMuted
															: colors.primary,
											})}
										>
											{run.status}
										</td>
										<td
											mix={css({
												padding: spacing.sm,
												borderBottom: `1px solid ${colors.border}`,
											})}
										>
											{formatDurationMs(run.durationMs)}
										</td>
										<td
											mix={css({
												padding: spacing.sm,
												borderBottom: `1px solid ${colors.border}`,
												color: colors.textMuted,
												maxWidth: '16rem',
												overflowWrap: 'anywhere',
											})}
										>
											{run.error ?? '—'}
										</td>
										<td
											mix={css({
												padding: spacing.sm,
												borderBottom: `1px solid ${colors.border}`,
											})}
										>
											<a
												href={routes.accountActivityDetail.href({
													runId: run.id,
												})}
												mix={css(primaryLinkCss)}
											>
												Logs
											</a>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</div>

			{detail.params ? (
				<div mix={css(fieldCss)}>
					<span mix={css(fieldLabelCss)}>Params</span>
					<div
						mix={css({
							'& pre': {
								margin: 0,
								padding: spacing.sm,
								borderRadius: radius.md,
								border: `1px solid ${colors.border}`,
								fontFamily: 'monospace',
								fontSize: typography.fontSize.sm,
								overflowX: 'auto',
								whiteSpace: 'pre-wrap',
							},
						})}
					>
						{renderHighlightedCode(
							detail.paramsHighlighted ??
								plainHighlightedCode(
									JSON.stringify(detail.params, null, 2),
									'json',
								),
						)}
					</div>
				</div>
			) : null}

			<div
				mix={css({
					display: 'flex',
					gap: spacing.sm,
					flexWrap: 'wrap',
				})}
			>
				<button
					type="button"
					disabled={isMutating}
					mix={[
						on('click', () =>
							postAction({
								body: { action: 'run_now', id: detail.id },
								successMessage: (payload) => {
									if (payload.runNow?.deletedAfterRun) {
										return payload.runNow.ok
											? 'Ran one-off job and deleted it.'
											: `Ran one-off job (failed) and deleted it${
													payload.runNow.error
														? `: ${payload.runNow.error}`
														: '.'
												}`
									}
									if (payload.runNow && !payload.runNow.ok) {
										return `Run finished with an error${
											payload.runNow.error ? `: ${payload.runNow.error}` : '.'
										}`
									}
									if (detail.schedule.type === 'once' && payload.runNow?.ok) {
										return detail.preserved
											? 'Job run finished. Preserved — will not be auto-deleted.'
											: `Job run finished. Kept for ${retention.successOnceDays} days · Preserve to keep forever.`
									}
									return 'Job run requested.'
								},
								failureMessage: 'Unable to run job now.',
								afterSuccess: (payload) => {
									if (payload.runNow?.deletedAfterRun) {
										navigateToList()
									}
								},
							}),
						),
						css(primaryButtonCss),
					]}
				>
					Run now
				</button>
				<button
					type="button"
					disabled={isMutating}
					mix={[
						on('click', () =>
							postAction({
								body: {
									action: 'set_kill_switch',
									id: detail.id,
									killSwitchEnabled: !detail.killSwitchEnabled,
								},
								successMessage: () =>
									detail.killSwitchEnabled
										? 'Cleared kill switch.'
										: 'Enabled kill switch.',
								failureMessage: 'Unable to update kill switch.',
							}),
						),
						css(secondaryButtonCss),
					]}
				>
					{detail.killSwitchEnabled
						? 'Clear kill switch'
						: 'Enable kill switch'}
				</button>
				{isNotPackageOwned ? (
					<button
						type="button"
						disabled={isMutating}
						mix={[
							on('click', () =>
								postAction({
									body: {
										action: 'set_preserved',
										id: detail.id,
										preserved: !detail.preserved,
									},
									successMessage: () =>
										detail.preserved
											? 'Cleared Preserve. This job can age out under retention.'
											: 'Preserved. This job will not be auto-deleted.',
									failureMessage: 'Unable to update Preserve.',
								}),
							),
							css(secondaryButtonCss),
						]}
					>
						{detail.preserved ? 'Clear Preserve' : 'Preserve'}
					</button>
				) : null}
				{isNotPackageOwned ? (
					<button
						type="button"
						disabled={isMutating}
						mix={[
							on('click', () =>
								postAction({
									body: {
										action: 'set_enabled',
										id: detail.id,
										enabled: !detail.enabled,
									},
									successMessage: () =>
										detail.enabled ? 'Disabled job.' : 'Enabled job.',
									failureMessage: 'Unable to update job.',
								}),
							),
							css(secondaryButtonCss),
						]}
					>
						{detail.enabled ? 'Disable' : 'Enable'}
					</button>
				) : null}
				{isNotPackageOwned ? (
					<button
						type="button"
						disabled={isMutating}
						mix={[
							...deleteJobCheck.getButtonMix({
								on: {
									click: () =>
										void postAction({
											body: { action: 'delete', id: detail.id },
											successMessage: () => 'Deleted job.',
											failureMessage: 'Unable to delete job.',
											afterSuccess: () => {
												navigateToList()
											},
										}),
								},
								resetAfterAction: false,
							}),
							css(dangerButtonCss),
						]}
					>
						{deleteJobCheck.doubleCheck ? 'Confirm delete' : 'Delete'}
					</button>
				) : null}
			</div>
		</section>
	)
}
