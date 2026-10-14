import { type Handle, css } from 'remix/component'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { on } from '#client/event-mixin.ts'
import { formatTimestamp } from '#client/format-timestamp.ts'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	MetadataGrid,
} from '#client/routes/account-management-components.tsx'
import { RecordTable } from '#client/routes/record-table.tsx'
import { formatEstimatedCreditMicroUsd } from '#universal/credits.ts'
import {
	type OrgCreditsBudget,
	type OrgCreditsLedgerEntry,
	type OrgCreditsLedgerPage,
	type OrgCreditsLoaderData,
} from '#universal/loader-data.ts'
import { parseOrgCreditsPath } from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	getGhostButtonCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'

function creditsApiPathForHref(href: string, cursor?: string) {
	const slug = parseOrgCreditsPath(
		new URL(href, 'http://localhost').pathname,
	)?.slug
	if (!slug) throw new Error(`Not an organization credits URL: ${href}`)
	const path = routes.orgCreditsApi.href({ orgSlug: slug })
	return cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path
}

async function fetchOrgCredits(
	href: string,
	signal?: AbortSignal,
	cursor?: string,
): Promise<OrgCreditsLoaderData | 'login'> {
	const response = await fetch(creditsApiPathForHref(href, cursor), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) return 'login'
	const payload = await readJson<OrgCreditsLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load credits.')
	}
	return payload
}

export async function orgCreditsRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const payload = await fetchOrgCredits(url.href, signal)
	if (payload === 'login') return routeLoaderRedirect('/login')
	return { orgCredits: payload }
}

/** Signed amount with sub-cent precision (usage debits are often under a cent). */
export function formatLedgerAmount(microUsd: number) {
	const formatted = formatEstimatedCreditMicroUsd(microUsd)
	return microUsd > 0 ? `+${formatted}` : formatted
}

export function formatBudgetLine(budget: OrgCreditsBudget) {
	const limit = formatEstimatedCreditMicroUsd(budget.budgetMicroUsd)
	return budget.spentMicroUsd === null
		? `${limit} per month (spend unavailable right now)`
		: `${formatEstimatedCreditMicroUsd(budget.spentMicroUsd)} of ${limit} spent this month`
}

function yourBudgetValue(data: OrgCreditsLoaderData) {
	const yours = data.budgets.yours
	if (!yours) return 'No monthly budget applies to you.'
	const source =
		yours.source === 'individual' ? 'set for you' : 'the organization default'
	return `${formatBudgetLine(yours)} (${source})`
}

function renderBudgets(data: OrgCreditsLoaderData) {
	const orgBudgets = data.budgets.org
	const items = [{ label: 'Your monthly budget', value: yourBudgetValue(data) }]
	if (orgBudgets) {
		items.push(
			{
				label: 'Default per-person budget',
				value:
					orgBudgets.defaultUserBudgetMicroUsd === null
						? 'None'
						: `${formatEstimatedCreditMicroUsd(orgBudgets.defaultUserBudgetMicroUsd)} per month`,
			},
			{
				label: 'Automation budget',
				value: orgBudgets.automation
					? formatBudgetLine(orgBudgets.automation)
					: 'None',
			},
		)
	}
	return (
		<AccountManagementPanel
			title="Budgets"
			description={`Monthly caps on credits spent past the include. Spend resets each UTC month (now ${data.budgets.month}).`}
		>
			<MetadataGrid items={items} />
		</AccountManagementPanel>
	)
}

function renderBalance(wallet: NonNullable<OrgCreditsLoaderData['wallet']>) {
	return (
		<AccountManagementPanel
			title="Balance"
			description={
				wallet.creditsEligible
					? 'Usage past the monthly include is charged here until it runs out.'
					: 'Credits pay for usage past the Pro monthly include. This organization is not on Pro, so the balance is kept until it is.'
			}
		>
			<p
				data-org-credits-balance
				mix={css({
					margin: 0,
					fontSize: 'clamp(2rem, 4vw, 2.6rem)',
					fontWeight: 760,
					letterSpacing: '-0.02em',
					fontVariantNumeric: 'tabular-nums',
					color: wallet.balanceMicroUsd < 0 ? colors.error : colors.text,
				})}
			>
				{formatEstimatedCreditMicroUsd(wallet.balanceMicroUsd)}
			</p>
			<p mix={css(descriptionCss)}>
				Auto-refill is {wallet.autoRefillEnabled ? 'on' : 'off'}.{' '}
				<a href={wallet.manageHref} mix={css(primaryLinkCss)}>
					Add credits or change auto-refill
				</a>
			</p>
		</AccountManagementPanel>
	)
}

function renderLedgerTable(entries: Array<OrgCreditsLedgerEntry>) {
	return (
		<RecordTable
			mode="none"
			ariaLabel="Credit ledger"
			scrollHeight="none"
			columns={[
				{ key: 'description', label: 'Entry', primary: true },
				{ key: 'type', label: 'Type', drop: 2 },
				{ key: 'date', label: 'Date', drop: 3 },
				{ key: 'amount', label: 'Amount', align: 'end' },
				{ key: 'balance', label: 'Balance after', align: 'end', drop: 1 },
			]}
			rows={entries.map((entry) => ({
				id: entry.id,
				cells: {
					description: (
						<span data-credits-ledger-kind={entry.kind}>
							{entry.description}
							{entry.detail ? (
								<span
									mix={css({
										display: 'block',
										color: colors.textMuted,
										fontSize: '0.85em',
									})}
								>
									{entry.detail}
								</span>
							) : null}
						</span>
					),
					type: entry.typeLabel,
					date: formatTimestamp(entry.createdAt),
					amount: (
						<span
							mix={css({
								color:
									entry.amountMicroUsd > 0 ? colors.primaryText : colors.text,
							})}
						>
							{formatLedgerAmount(entry.amountMicroUsd)}
						</span>
					),
					balance: formatEstimatedCreditMicroUsd(entry.balanceAfterMicroUsd),
				},
			}))}
		/>
	)
}

export function OrgCreditsRoute(handle: Handle) {
	/** Older pages appended to the loaded snapshot by Load older. */
	let older: {
		from: OrgCreditsLoaderData
		entries: Array<OrgCreditsLedgerEntry>
		nextCursor: string | null
	} | null = null
	let loadingOlder = false
	let olderError: string | null = null

	const creditsData = createRouteData({
		key: 'orgCredits',
		async load(href, signal) {
			const payload = await fetchOrgCredits(href, signal)
			return payload === 'login' ? routeDataRedirect('/login') : payload
		},
	})

	async function loadOlder(
		data: OrgCreditsLoaderData,
		ledger: OrgCreditsLedgerPage,
	) {
		if (loadingOlder || !ledger.nextCursor) return
		loadingOlder = true
		olderError = null
		handle.update()
		try {
			const payload = await fetchOrgCredits(
				readCurrentRouterHref(handle),
				undefined,
				ledger.nextCursor,
			)
			if (payload === 'login') {
				window.location.assign('/login')
				return
			}
			const page = payload.ledger
			if (!page) throw new Error('Unable to load older credit activity.')
			older = {
				from: data,
				entries: [
					...(older?.from === data ? older.entries : []),
					...page.entries,
				],
				nextCursor: page.nextCursor,
			}
		} catch (error) {
			olderError =
				error instanceof Error
					? error.message
					: 'Unable to load older credit activity.'
		}
		loadingOlder = false
		handle.update()
	}

	function renderLedger(data: OrgCreditsLoaderData) {
		if (!data.ledger || !data.wallet) return null
		const extra = older?.from === data ? older : null
		const entries = [...data.ledger.entries, ...(extra?.entries ?? [])]
		const ledger: OrgCreditsLedgerPage = {
			entries,
			nextCursor: extra ? extra.nextCursor : data.ledger.nextCursor,
		}
		return (
			<AccountManagementPanel
				title="Ledger"
				description="Every change to the balance, newest first: purchases, auto-refills, grants, and usage charges."
			>
				{entries.length === 0 ? (
					<p mix={css(descriptionCss)}>No credit activity yet.</p>
				) : (
					renderLedgerTable(entries)
				)}
				{olderError ? (
					<AccountManagementMessage tone="error">
						{olderError}
					</AccountManagementMessage>
				) : null}
				<div
					mix={css({
						display: 'flex',
						flexWrap: 'wrap',
						gap: spacing.md,
						alignItems: 'center',
					})}
				>
					{ledger.nextCursor ? (
						<button
							type="button"
							disabled={loadingOlder}
							data-org-credits-load-older
							mix={[
								css(getGhostButtonCss({ size: 'sm' })),
								on('click', () => void loadOlder(data, ledger)),
							]}
						>
							{loadingOlder ? 'Loading…' : 'Load older'}
						</button>
					) : null}
					<a href={data.wallet.whereItWentHref} mix={css(primaryLinkCss)}>
						See which packages used credits this month
					</a>
				</div>
			</AccountManagementPanel>
		)
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const snapshot = creditsData.read(handle, currentHref)
		const data = snapshot.data
		const pending = snapshot.kind === 'pending'
		return (
			<AccountManagementShell busy={pending && data !== null}>
				<AccountPageHeader
					title="Credits"
					description="Credit balance, budgets, and every credit added or spent."
					currentHref={currentHref}
				/>
				{snapshot.error ? (
					<AccountManagementMessage tone="error">
						{snapshot.error.message}
					</AccountManagementMessage>
				) : null}
				{pending && data === null ? (
					<p mix={css(descriptionCss)}>Loading credits…</p>
				) : null}
				{data ? (
					<>
						{data.wallet ? renderBalance(data.wallet) : null}
						{renderBudgets(data)}
						{data.access === 'member' ? (
							<p mix={css(descriptionCss)} data-org-credits-member-note>
								Owners and billing admins see the balance and ledger.
							</p>
						) : null}
						{renderLedger(data)}
					</>
				) : null}
			</AccountManagementShell>
		)
	}
}
