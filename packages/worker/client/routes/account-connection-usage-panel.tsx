import { type Handle, type RemixNode, css } from 'remix/component'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	AccountManagementPanel,
	TimestampValue,
} from '#client/routes/account-management-components.tsx'
import { accountConnectionsUsageHref } from '#universal/account-connections.ts'
import {
	connectionUsageWindowKeys,
	type AccountConnectionUsageLoaderData,
	type ConnectionUsageCaller,
	type ConnectionUsageCountKey,
	type ConnectionUsageTotals,
	type ConnectionUsageWindow,
} from '#universal/connection-usage.ts'
import {
	connectionUsageCountKeys,
	connectionUsageCountNoun,
	connectionUsageEntryLabel,
	connectionUsageHasActivity,
	connectionUsageKindLabel,
	connectionUsageOtherCounts,
	connectionUsageWindowLabels,
	formatConnectionUsageCount,
	formatConnectionUsageQuantity,
} from '#universal/connection-usage-presentation.ts'
import { type ConnectedMcpAgent } from '#universal/connected-mcp-agents.ts'
import {
	descriptionCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

const connectionUsageApiPath = '/account/connection-usage.json'

/** Rows on the Connections list before "View usage details". */
const summaryRowLimit = 6

/**
 * Binds the org from the Referer like `/account/connected-agents.json`; a
 * route loader runs before the URL commits, so name the destination page.
 */
export async function fetchConnectionUsage(href: string, signal: AbortSignal) {
	const response = await fetch(connectionUsageApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		referrer: new URL(href, window.location.origin).href,
		signal,
	})
	if (response.status === 401) return { kind: 'unauthorized' as const }
	const payload = await readJson<AccountConnectionUsageLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load connection usage.')
	}
	return { kind: 'ok' as const, payload }
}

type Agents = ReadonlyArray<Pick<ConnectedMcpAgent, 'clientId' | 'label'>>

export type ConnectionUsageState =
	| { kind: 'loading' }
	| { kind: 'error'; message: string }
	| { kind: 'ready'; usage: AccountConnectionUsageLoaderData }

type UsageRow = {
	id: string
	name: string
	detail: string
	href: string | null
	totals: ConnectionUsageTotals
}

function formatDay(day: string, withYear: boolean) {
	const date = new Date(`${day}T00:00:00.000Z`)
	if (Number.isNaN(date.getTime())) return day
	return date.toLocaleString('en-US', {
		month: 'short',
		day: 'numeric',
		...(withYear ? { year: 'numeric' } : {}),
		timeZone: 'UTC',
	})
}

/** Years appear only when the window spans New Year: `Dec 29, 2026 – Jan 4, 2027`. */
function formatWindow(window: ConnectionUsageWindow) {
	const withYear = window.startDay.slice(0, 4) !== window.endDay.slice(0, 4)
	return window.startDay === window.endDay
		? formatDay(window.startDay, false)
		: `${formatDay(window.startDay, withYear)} – ${formatDay(window.endDay, withYear)}`
}

function capWeekTotal(row: UsageRow, capCountKey: ConnectionUsageCountKey) {
	return row.totals.capWeek[capCountKey]
}

function usageRows(input: {
	usage: AccountConnectionUsageLoaderData
	agents: Agents
	pathname: string
}): Array<UsageRow> {
	const { usage } = input
	const rows: Array<UsageRow> = usage.connections.map((entry) => ({
		id: entry.id,
		name: connectionUsageEntryLabel(entry, input.agents),
		detail: connectionUsageKindLabel(entry.credentialKind),
		href: accountConnectionsUsageHref(input.pathname, entry.id),
		totals: entry.totals,
	}))
	for (const automation of usage.automations ?? []) {
		rows.push({
			id: automation.id,
			name: automation.label,
			detail: 'Automation',
			href: accountConnectionsUsageHref(input.pathname, automation.id),
			totals: automation.totals,
		})
	}
	for (const [index, person] of (usage.people ?? []).entries()) {
		rows.push({
			id: personRowId(person.username, index),
			name: person.username ? `@${person.username}` : 'Former member',
			detail: 'Teammate',
			href: null,
			totals: person.totals,
		})
	}
	return rows
		.filter((row) => connectionUsageHasActivity(row.totals))
		.sort(
			(a, b) =>
				capWeekTotal(b, usage.capCountKey) - capWeekTotal(a, usage.capCountKey),
		)
}

function UsageTable(
	handle: Handle<{
		caption: string
		rowHeader: string
		rows: Array<UsageRow>
		capCountKey: ConnectionUsageCountKey
		testId: string
	}>,
) {
	return () => {
		const { capCountKey } = handle.props
		return (
			<div mix={css(tableScrollCss)}>
				<table data-testid={handle.props.testId} mix={css(tableCss)}>
					<caption mix={css(captionCss)}>{handle.props.caption}</caption>
					<thead>
						<tr>
							<th scope="col">{handle.props.rowHeader}</th>
							{connectionUsageWindowKeys.map((key) => (
								<th key={key} scope="col" mix={css(numericCss)}>
									{connectionUsageWindowLabels[key]}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{handle.props.rows.map((row) => (
							<tr key={row.id} data-connection-usage-row={row.id}>
								<th scope="row">
									<span mix={css(rowHeaderCss)}>
										{row.href ? (
											<a href={row.href} mix={css(primaryLinkCss)}>
												{row.name}
											</a>
										) : (
											<span>{row.name}</span>
										)}
										<span mix={css(rowDetailCss)}>
											{rowDetail(row, capCountKey)}
										</span>
									</span>
								</th>
								{connectionUsageWindowKeys.map((key) => (
									<td
										key={key}
										mix={css(numericCss)}
										data-connection-usage-window={key}
									>
										{formatConnectionUsageCount(row.totals[key][capCountKey])}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		)
	}
}

function rowDetail(row: UsageRow, capCountKey: ConnectionUsageCountKey) {
	const other = connectionUsageOtherCounts(row.totals, capCountKey)
	return other ? `${row.detail} · 7 days: ${other}` : row.detail
}

function RawCountsTable(
	handle: Handle<{ caption: string; totals: ConnectionUsageTotals }>,
) {
	return () => (
		<div mix={css(tableScrollCss)}>
			<table data-testid="connection-usage-raw-counts" mix={css(tableCss)}>
				<caption mix={css(captionCss)}>{handle.props.caption}</caption>
				<thead>
					<tr>
						<th scope="col">Count</th>
						{connectionUsageWindowKeys.map((key) => (
							<th key={key} scope="col" mix={css(numericCss)}>
								{connectionUsageWindowLabels[key]}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{connectionUsageCountKeys.map((countKey) => (
						<tr key={countKey} data-connection-usage-count={countKey}>
							<th scope="row" mix={css(rawCountHeaderCss)}>
								{capitalize(connectionUsageCountNoun(countKey))}
							</th>
							{connectionUsageWindowKeys.map((key) => (
								<td key={key} mix={css(numericCss)}>
									{formatConnectionUsageCount(
										handle.props.totals[key][countKey],
									)}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}

function capitalize(value: string) {
	return value.charAt(0).toUpperCase() + value.slice(1)
}

function capUnitSentence(usage: AccountConnectionUsageLoaderData) {
	return `Counts are ${connectionUsageCountNoun(usage.capCountKey)}, the unit the hosted execute cap counts.`
}

function renderUpdated(usage: AccountConnectionUsageLoaderData) {
	return (
		<p mix={css(updatedCss)} data-testid="connection-usage-updated">
			{usage.updatedAt ? (
				<>
					Updated <TimestampValue value={usage.updatedAt} />. Usage refreshes
					hourly and is kept {usage.retentionDays} days.
				</>
			) : (
				`Usage refreshes hourly and is kept ${usage.retentionDays} days.`
			)}
		</p>
	)
}

function renderState(state: ConnectionUsageState, ready: () => RemixNode) {
	switch (state.kind) {
		case 'loading':
			return <p mix={css(descriptionCss)}>Loading usage…</p>
		case 'error':
			return (
				<p role="alert" mix={css(descriptionCss)}>
					{state.message}
				</p>
			)
		case 'ready':
			return ready()
		default: {
			const exhaustive: never = state
			return exhaustive
		}
	}
}

/** Connections list: who used the cap this week, heaviest first. */
export function ConnectionUsageSummaryPanel(
	handle: Handle<{
		state: ConnectionUsageState
		agents: Agents
		pathname: string
	}>,
) {
	return () => {
		const { state } = handle.props
		return (
			<AccountManagementPanel
				title="Usage by connection"
				description="Which agents, CLI logins, API tokens, and automations ran code here, so you can see what is using your execute cap."
				ariaLabel="Usage by connection"
			>
				<div data-testid="connection-usage-summary" mix={css(stackCss)}>
					{renderState(state, () => {
						if (state.kind !== 'ready') return null
						const rows = usageRows({
							usage: state.usage,
							agents: handle.props.agents,
							pathname: handle.props.pathname,
						})
						return (
							<>
								{rows.length === 0 ? (
									<p mix={css(descriptionCss)}>
										No usage through these connections in the last 7 days.
									</p>
								) : (
									<UsageTable
										caption={capUnitSentence(state.usage)}
										rowHeader="Connection"
										rows={rows.slice(0, summaryRowLimit)}
										capCountKey={state.usage.capCountKey}
										testId="connection-usage-summary-table"
									/>
								)}
								{renderUpdated(state.usage)}
							</>
						)
					})}
					<p mix={css({ margin: 0 })}>
						<a
							href={accountConnectionsUsageHref(handle.props.pathname)}
							data-testid="connection-usage-details-link"
							mix={css(primaryLinkCss)}
						>
							View usage details
						</a>
					</p>
				</div>
			</AccountManagementPanel>
		)
	}
}

/** `/connections/usage`: per-connection totals and what called through each. */
export function ConnectionUsageDetails(
	handle: Handle<{
		state: ConnectionUsageState
		agents: Agents
		pathname: string
		/** `ConnectionUsageEntry.id` from `?connection=`. */
		focus: string | null
	}>,
) {
	return () => {
		const { state } = handle.props
		if (state.kind !== 'ready') {
			return (
				<AccountManagementPanel
					title="Connection usage"
					ariaLabel="Connection usage"
				>
					{renderState(state, () => null)}
				</AccountManagementPanel>
			)
		}
		const { usage } = state
		const focus = handle.props.focus
		const connections = usage.connections.filter(
			(entry) => !focus || entry.id === focus,
		)
		const automations = (usage.automations ?? []).filter(
			(entry) => !focus || entry.id === focus,
		)
		const focusMissing =
			focus !== null && connections.length === 0 && automations.length === 0
		const windowsText = connectionUsageWindowKeys
			.map(
				(key) =>
					`${connectionUsageWindowLabels[key]}: ${formatWindow(usage.windows[key])} (UTC)`,
			)
			.join(' · ')
		return (
			<>
				<AccountManagementPanel
					title="Connection usage"
					description={`${capUnitSentence(usage)} ${windowsText}.`}
					ariaLabel="Connection usage"
				>
					<div mix={css(stackCss)}>
						{renderUpdated(usage)}
						{focus ? (
							<p mix={css({ margin: 0 })}>
								<a
									href={accountConnectionsUsageHref(handle.props.pathname)}
									data-testid="connection-usage-show-all"
									mix={css(primaryLinkCss)}
								>
									Show all connections
								</a>
							</p>
						) : null}
						{focusMissing ? (
							<p mix={css(descriptionCss)}>
								No usage for that connection in the last 7 days.
							</p>
						) : null}
						{usage.automations === null ? (
							<p
								mix={css(descriptionCss)}
								data-testid="connection-usage-own-only"
							>
								You see usage for your own connections. Owners and billing
								admins also see automations and teammates.
							</p>
						) : null}
					</div>
				</AccountManagementPanel>
				{connections.length === 0 && !focus ? (
					<AccountManagementPanel
						title="Your connections"
						ariaLabel="Your connections"
					>
						<p mix={css(descriptionCss)}>
							No usage through your connections in the last 7 days.
						</p>
					</AccountManagementPanel>
				) : null}
				{connections.map((entry) => {
					const name = connectionUsageEntryLabel(entry, handle.props.agents)
					return (
						<AccountManagementPanel
							key={entry.id}
							title={name}
							description={connectionUsageKindLabel(entry.credentialKind)}
							ariaLabel={`${name} usage`}
						>
							<div
								data-testid="connection-usage-entry"
								data-connection-usage-entry={entry.id}
								mix={css(stackCss)}
							>
								<RawCountsTable
									caption={`${name}: all counts`}
									totals={entry.totals}
								/>
								{renderCallersTable({
									name,
									callers: entry.callers,
									capCountKey: usage.capCountKey,
								})}
							</div>
						</AccountManagementPanel>
					)
				})}
				{usage.automations !== null && (!focus || automations.length > 0) ? (
					<AccountManagementPanel
						title="Automations"
						description="Scheduled jobs, webhooks, inbound email, and event subscriptions run without a connection."
						ariaLabel="Automations"
					>
						{automations.length === 0 ? (
							<p mix={css(descriptionCss)}>
								No automation usage in the last 7 days.
							</p>
						) : (
							<UsageTable
								caption={`Automation usage, in ${connectionUsageCountNoun(usage.capCountKey)}`}
								rowHeader="Automation"
								rows={automations.map((automation) => ({
									id: automation.id,
									name: automation.label,
									detail: connectionUsageAutomationDetail(automation.callers),
									href: automation.href,
									totals: automation.totals,
								}))}
								capCountKey={usage.capCountKey}
								testId="connection-usage-automations"
							/>
						)}
						{focus
							? automations.map((automation) => (
									<div
										key={automation.id}
										data-testid="connection-usage-automation-entry"
										mix={css(stackCss)}
									>
										<RawCountsTable
											caption={`${automation.label}: all counts`}
											totals={automation.totals}
										/>
										{renderCallersTable({
											name: automation.label,
											callers: automation.callers,
											capCountKey: usage.capCountKey,
										})}
									</div>
								))
							: null}
					</AccountManagementPanel>
				) : null}
				{usage.people !== null && !focus ? (
					<AccountManagementPanel
						title="Teammates"
						description="Usage by other people in this organization, through their own connections."
						ariaLabel="Teammates"
					>
						{usage.people.length === 0 ? (
							<p mix={css(descriptionCss)}>
								No teammate usage in the last 7 days.
							</p>
						) : (
							<UsageTable
								caption={`Teammate usage, in ${connectionUsageCountNoun(usage.capCountKey)}`}
								rowHeader="Person"
								rows={usage.people.map((person, index) => ({
									id: personRowId(person.username, index),
									name: person.username
										? `@${person.username}`
										: 'Former member',
									detail: 'Teammate',
									href: null,
									totals: person.totals,
								}))}
								capCountKey={usage.capCountKey}
								testId="connection-usage-people"
							/>
						)}
					</AccountManagementPanel>
				) : null}
				{usage.unattributed &&
				!focus &&
				connectionUsageHasActivity(usage.unattributed) ? (
					<p
						mix={css(descriptionCss)}
						data-testid="connection-usage-unattributed"
					>
						{`${unattributedQuantity(usage.unattributed, usage.capCountKey)} in the last 7 days were recorded before connection tracking started and are not tied to a connection.`}
					</p>
				) : null}
			</>
		)
	}
}

function personRowId(username: string | null, index: number) {
	return username ? `person:${username}` : `person:former:${index}`
}

/** The cap unit, plus any other counts so runs-only history does not read as zero. */
function unattributedQuantity(
	totals: ConnectionUsageTotals,
	capCountKey: ConnectionUsageCountKey,
) {
	const cap = totals.last7Days[capCountKey]
	const other = connectionUsageOtherCounts(totals, capCountKey)
	if (cap > 0 || !other) {
		return formatConnectionUsageQuantity(capCountKey, cap)
	}
	return other
}

function renderCallersTable(input: {
	name: string
	callers: ReadonlyArray<ConnectionUsageCaller>
	capCountKey: ConnectionUsageCountKey
}) {
	return (
		<UsageTable
			caption={`What ran through ${input.name}, in ${connectionUsageCountNoun(input.capCountKey)}`}
			rowHeader="Package"
			rows={input.callers.map((caller) => ({
				id: caller.packageId || 'adhoc',
				name: caller.label,
				detail: caller.packageId ? 'Package' : 'Ad hoc execute',
				href: caller.href,
				totals: caller.totals,
			}))}
			capCountKey={input.capCountKey}
			testId="connection-usage-callers"
		/>
	)
}

function connectionUsageAutomationDetail(
	callers: ReadonlyArray<{ packageId: string; label: string }>,
) {
	const packages = callers
		.filter((caller) => caller.packageId)
		.map((caller) => caller.label)
	return packages.length > 0 ? `Runs ${packages.join(', ')}` : 'Automation'
}

const updatedCss = {
	...descriptionCss,
	fontSize: typography.fontSize.sm,
}

const stackCss = {
	display: 'grid',
	gap: spacing.md,
	minWidth: 0,
}

const tableScrollCss = {
	display: 'block',
	minWidth: 0,
	maxWidth: '100%',
	overflowX: 'auto' as const,
}

const tableCss = {
	width: '100%',
	borderCollapse: 'collapse' as const,
	fontSize: typography.fontSize.sm,
	color: colors.text,
	'& th, & td': {
		padding: `${spacing.xs} ${spacing.sm}`,
		borderBottom: `1px solid ${colors.border}`,
		textAlign: 'start' as const,
		verticalAlign: 'top' as const,
	},
	'& thead th': {
		color: colors.textMuted,
		fontWeight: typography.fontWeight.semibold,
		whiteSpace: 'nowrap' as const,
	},
}

const captionCss = {
	captionSide: 'top' as const,
	textAlign: 'start' as const,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	paddingBottom: spacing.xs,
}

const numericCss = {
	textAlign: 'end' as const,
	fontVariantNumeric: 'tabular-nums' as const,
	whiteSpace: 'nowrap' as const,
}

const rowHeaderCss = {
	display: 'grid',
	gap: '0.15rem',
	fontWeight: typography.fontWeight.medium,
	minWidth: '10rem',
}

const rawCountHeaderCss = {
	fontWeight: typography.fontWeight.medium,
	whiteSpace: 'nowrap' as const,
}

const rowDetailCss = {
	color: colors.textMuted,
	fontWeight: typography.fontWeight.normal,
	fontSize: typography.fontSize.xs,
}
