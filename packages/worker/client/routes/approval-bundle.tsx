// remix-skill: agent-prefilled approval bundle (`/@org/-/approvals/:bundleId`).
import { type Handle, type RemixNode, css } from 'remix/component'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { on } from '#client/event-mixin.ts'
import { NotFoundPage } from '#client/not-found-page.tsx'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import {
	type RouteLoaderResult,
	routeLoaderRedirect,
} from '#client/route-loader.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	IdValue,
	MetadataGrid,
	accountDisclosureCss,
} from '#client/routes/account-management-components.tsx'
import {
	approvalBundleApiPath,
	approvalItemsAwaitingDecision,
	approvalItemsReadyToApprove,
	approvalItemStatusLabel,
	approveAllLabel,
	type ApprovalBundleDecisionResponse,
	type ApprovalBundleLoaderData,
	type ApprovalBundlePackageGroup,
	type ApprovalBundleView,
	type ApprovalGrantLine,
	type ApprovalItemSecurityAudit,
	type ApprovalItemStatus,
	type ApprovalItemView,
} from '#universal/approval-bundles.ts'
import { parseOrgApprovalBundlePath } from '#universal/org-pages.ts'
import { packageSecurityAuditAnchor } from '#universal/package-security-audit-prompt.ts'
import { auditedLabel } from '#client/routes/package-security-audit-field.tsx'
import {
	cardCss,
	cardTitleCss,
	getDangerButtonCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	insetCardCss,
	pageDescriptionCss,
	pageEyebrowCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

const approveAllButtonCss = getPrimaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})
const approveButtonCss = getPrimaryButtonCss({ size: 'md' })
const denyButtonCss = getSecondaryButtonCss({ size: 'md' })
const denyConfirmButtonCss = getDangerButtonCss({ size: 'md' })
const mutedCss = { margin: 0, color: colors.textMuted }

function securityAuditText(audit: ApprovalItemSecurityAudit) {
	if (audit.status === 'not_audited') return 'No security audit performed'
	return `${auditedLabel(audit)} · ${audit.verdict === 'pass' ? 'Pass' : 'Concerns'}`
}
const smallMutedCss = { ...mutedCss, fontSize: typography.fontSize.sm }
const listCss = {
	margin: 0,
	padding: 0,
	listStyle: 'none',
	display: 'grid',
	gap: spacing.sm,
}

type BundlePath = { orgSlug: string; bundleId: string }

function readBundlePath(href: string): BundlePath | null {
	const parsed = parseOrgApprovalBundlePath(
		new URL(href, 'http://localhost').pathname,
	)
	return parsed ? { orgSlug: parsed.slug, bundleId: parsed.bundleId } : null
}

function loginRedirect(href: string) {
	return `/login?redirectTo=${encodeURIComponent(href)}`
}

type BundleLoadResult =
	| { kind: 'data'; data: ApprovalBundleLoaderData }
	| { kind: 'redirect'; to: string }

export async function loadApprovalBundle(
	href: string,
	signal: AbortSignal,
): Promise<BundleLoadResult> {
	const path = readBundlePath(href)
	if (!path) return { kind: 'data', data: { ok: false, reason: 'not-found' } }
	const response = await fetch(approvalBundleApiPath(path), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		const url = new URL(href, 'http://localhost')
		return { kind: 'redirect', to: loginRedirect(url.pathname) }
	}
	if (response.status === 404) {
		return { kind: 'data', data: { ok: false, reason: 'not-found' } }
	}
	if (response.status === 410) {
		return { kind: 'data', data: { ok: false, reason: 'expired' } }
	}
	const view = await readJson<ApprovalBundleView>(response)
	if (!response.ok || !view?.ok) {
		throw new Error(
			`Kody could not load these approvals (HTTP ${response.status}).`,
		)
	}
	return { kind: 'data', data: { ok: true, view } }
}

export async function approvalBundleRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const result = await loadApprovalBundle(url.pathname, signal)
	return result.kind === 'redirect'
		? routeLoaderRedirect(result.to)
		: { approvalBundle: result.data }
}

function statusColor(status: ApprovalItemStatus) {
	switch (status) {
		case 'pending':
			return colors.warningText
		case 'approved':
			return colors.primary
		case 'denied':
			return colors.danger
		case 'resolved':
		case 'unavailable':
			return colors.textMuted
		default: {
			const exhaustive: never = status
			throw new Error(`Unknown approval status: ${String(exhaustive)}`)
		}
	}
}

function changeLabel(change: ApprovalGrantLine['change']) {
	switch (change) {
		case 'added':
			return 'New'
		case 'changed':
			return 'Changed'
		case 'removed':
			return 'Removed'
		default: {
			const exhaustive: never = change
			throw new Error(`Unknown grant change: ${String(exhaustive)}`)
		}
	}
}

function itemDetailCopyLabel(label: string) {
	return label.toLowerCase()
}

function renderGrant(grant: ApprovalGrantLine, index: number) {
	const facts = [
		grant.kind,
		grant.provider ? `provider ${grant.provider}` : null,
		grant.hosts.length > 0 ? `reaches ${grant.hosts.join(', ')}` : null,
	].filter(Boolean)
	return (
		<li
			key={index}
			data-testid="approval-bundle-grant"
			mix={css({ ...insetCardCss, display: 'grid', gap: spacing.xs })}
		>
			<div
				mix={css({
					display: 'flex',
					flexWrap: 'wrap',
					gap: spacing.sm,
					alignItems: 'baseline',
				})}
			>
				<span
					mix={css({
						fontSize: typography.fontSize.xs,
						fontWeight: typography.fontWeight.semibold,
						textTransform: 'uppercase',
						letterSpacing: '0.04em',
						color:
							grant.change === 'removed'
								? colors.textMuted
								: colors.warningText,
					})}
				>
					{changeLabel(grant.change)}
				</span>
				<strong>{grant.label}</strong>
				{grant.where ? (
					<span mix={css(smallMutedCss)}>{grant.where}</span>
				) : null}
			</div>
			{facts.length > 0 ? (
				<p mix={css(smallMutedCss)}>{facts.join(' · ')}</p>
			) : null}
			{grant.before || grant.after ? (
				<dl
					mix={css({
						margin: 0,
						display: 'grid',
						gridTemplateColumns: 'max-content 1fr',
						columnGap: spacing.sm,
						rowGap: spacing.xs,
						'& dt': { color: colors.textMuted },
						'& dd': { margin: 0 },
					})}
				>
					<dt>Approved before</dt>
					<dd>{grant.before ?? 'Nothing'}</dd>
					<dt>After</dt>
					<dd>
						<strong>{grant.after ?? 'Removed'}</strong>
					</dd>
				</dl>
			) : null}
			{grant.match ? <p mix={css({ margin: 0 })}>{grant.match}</p> : null}
		</li>
	)
}

export function ApprovalBundleRoute(handle: Handle) {
	let baseView: ApprovalBundleView | null = null
	/** Items as the latest decision responses left them, by item key. */
	let updated = new Map<string, ApprovalItemView>()
	let errors = new Map<string, string>()
	let busy = new Set<string>()
	let confirmingDeny: string | null = null
	let approveAll: { done: number; total: number } | null = null
	let summary: string | null = null

	const bundleData = createRouteData<
		'approvalBundle',
		ApprovalBundleLoaderData
	>({
		key: 'approvalBundle',
		fromLoaderData: (payload) => payload,
		async load(href, signal) {
			const result = await loadApprovalBundle(href, signal)
			return result.kind === 'redirect'
				? routeDataRedirect(result.to)
				: result.data
		},
	})

	function itemFor(item: ApprovalItemView) {
		return updated.get(item.key) ?? item
	}

	function currentGroups(view: ApprovalBundleView) {
		return view.groups.map((group) => ({
			...group,
			items: group.items.map(itemFor),
		}))
	}

	function awaitingDecision(view: ApprovalBundleView) {
		return approvalItemsAwaitingDecision({ groups: currentGroups(view) })
	}

	function readyToApprove(view: ApprovalBundleView) {
		return approvalItemsReadyToApprove({ groups: currentGroups(view) })
	}

	async function decide(
		path: BundlePath,
		item: ApprovalItemView,
		action: 'approve' | 'deny',
	): Promise<boolean> {
		if (busy.has(item.key) || !item.fingerprint) return false
		busy = new Set(busy).add(item.key)
		errors = new Map(errors)
		errors.delete(item.key)
		handle.update()
		const response = await fetch(approvalBundleApiPath(path), {
			method: 'POST',
			credentials: 'include',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				action,
				item: item.key,
				fingerprint: item.fingerprint,
			}),
		}).catch(() => null)
		busy = new Set(busy)
		busy.delete(item.key)
		if (!response) {
			errors = new Map(errors).set(
				item.key,
				'Kody could not be reached. Try again.',
			)
			handle.update()
			return false
		}
		if (response.status === 401) {
			window.location.assign(loginRedirect(window.location.pathname))
			return false
		}
		const payload = await readJson<ApprovalBundleDecisionResponse>(response)
		if (payload?.item) {
			updated = new Map(updated).set(item.key, payload.item)
		}
		const ok = response.ok && payload?.ok === true
		if (!ok) {
			errors = new Map(errors).set(
				item.key,
				(payload && !payload.ok ? payload.error : null) ||
					`Kody could not ${action} this item (HTTP ${response.status}).`,
			)
		}
		handle.update()
		return ok
	}

	async function runApproveAll(path: BundlePath, view: ApprovalBundleView) {
		if (approveAll) return
		const queue = readyToApprove(view).filter((item) => !busy.has(item.key))
		if (queue.length === 0) return
		approveAll = { done: 0, total: queue.length }
		summary = null
		handle.update()
		let approved = 0
		try {
			for (const [index, item] of queue.entries()) {
				if (await decide(path, item, 'approve')) approved += 1
				approveAll = { done: index + 1, total: queue.length }
				handle.update()
			}
		} finally {
			approveAll = null
			handle.update()
		}
		const failed = queue.length - approved
		summary =
			failed === 0
				? `Approved ${approved} of ${queue.length}.`
				: `Approved ${approved} of ${queue.length}. ${failed} need${failed === 1 ? 's' : ''} another look; see the message on ${failed === 1 ? 'it' : 'each'}.`
		handle.update()
	}

	function renderItem(path: BundlePath, item: ApprovalItemView): RemixNode {
		const isBusy = busy.has(item.key)
		const locked = isBusy || approveAll !== null
		const error = errors.get(item.key) ?? null
		const decided = item.status !== 'pending'
		return (
			<li
				key={item.key}
				data-testid="approval-bundle-item"
				data-item={item.key}
				data-status={item.status}
				mix={css({
					display: 'grid',
					gap: spacing.sm,
					paddingTop: spacing.md,
					borderTop: `1px solid ${colors.border}`,
				})}
			>
				<div
					mix={css({
						display: 'flex',
						flexWrap: 'wrap',
						gap: spacing.sm,
						alignItems: 'baseline',
						justifyContent: 'space-between',
					})}
				>
					<h3
						mix={css({
							margin: 0,
							fontSize: typography.fontSize.base,
							fontWeight: typography.fontWeight.semibold,
						})}
					>
						{item.title}
					</h3>
					<span
						data-testid="approval-bundle-item-status"
						mix={css({
							fontSize: typography.fontSize.sm,
							fontWeight: typography.fontWeight.semibold,
							color: statusColor(item.status),
							padding: `0 ${spacing.sm}`,
							borderRadius: radius.full,
							border: `1px solid currentColor`,
						})}
					>
						{approvalItemStatusLabel(item.status)}
					</span>
				</div>
				<p mix={css({ margin: 0, whiteSpace: 'pre-wrap' })}>{item.summary}</p>
				{item.grants.length > 0 ? (
					<ul mix={css(listCss)}>{item.grants.map(renderGrant)}</ul>
				) : null}
				{item.fingerprint && item.detailLabel ? (
					<details
						data-testid="approval-bundle-item-details"
						mix={css(accountDisclosureCss)}
					>
						<summary>Details</summary>
						<MetadataGrid
							items={[
								{
									key: 'id',
									label: item.detailLabel,
									value: (
										<IdValue
											value={item.fingerprint}
											label={itemDetailCopyLabel(item.detailLabel)}
										/>
									),
								},
							]}
						/>
					</details>
				) : null}
				{item.statusMessage ? (
					<p mix={css(mutedCss)}>{item.statusMessage}</p>
				) : null}
				{item.securityAudit && item.reviewHref ? (
					<p
						data-testid="approval-bundle-security-audit"
						mix={css(smallMutedCss)}
					>
						Security audit:{' '}
						<a href={`${item.reviewHref}#${packageSecurityAuditAnchor}`}>
							{securityAuditText(item.securityAudit)}
						</a>
					</p>
				) : null}
				{error ? (
					<p
						role="alert"
						data-testid="approval-bundle-item-error"
						mix={css({ margin: 0, color: colors.danger })}
					>
						{error}
					</p>
				) : null}
				<div
					mix={css({
						display: 'flex',
						flexWrap: 'wrap',
						gap: spacing.sm,
						alignItems: 'center',
					})}
				>
					{!decided && item.canApprove ? (
						<button
							type="button"
							data-testid="approval-bundle-approve"
							disabled={locked}
							mix={[
								css(approveButtonCss),
								on('click', () => void decide(path, item, 'approve')),
							]}
						>
							{isBusy ? 'Working…' : 'Approve'}
						</button>
					) : null}
					{!decided && item.canDeny ? (
						confirmingDeny === item.key ? (
							<>
								<button
									type="button"
									data-testid="approval-bundle-deny-confirm"
									disabled={locked}
									mix={[
										css(denyConfirmButtonCss),
										on('click', () => {
											confirmingDeny = null
											void decide(path, item, 'deny')
										}),
									]}
								>
									{item.type === 'publish' ? 'Deny and drop it' : 'Deny'}
								</button>
								<button
									type="button"
									disabled={locked}
									mix={[
										css(denyButtonCss),
										on('click', () => {
											confirmingDeny = null
											handle.update()
										}),
									]}
								>
									Keep
								</button>
							</>
						) : (
							<button
								type="button"
								data-testid="approval-bundle-deny"
								disabled={locked}
								mix={[
									css(denyButtonCss),
									on('click', () => {
										confirmingDeny = item.key
										handle.update()
									}),
								]}
							>
								Deny
							</button>
						)
					) : null}
					{item.reviewHref ? (
						<a href={item.reviewHref} mix={css(smallMutedCss)}>
							Open its own approval page
						</a>
					) : null}
				</div>
			</li>
		)
	}

	function renderGroup(
		path: BundlePath,
		group: ApprovalBundlePackageGroup,
		index: number,
	) {
		return (
			<section
				key={group.package?.id ?? `unavailable-${index}`}
				aria-label={group.package?.name ?? 'Unavailable items'}
				data-testid="approval-bundle-group"
				mix={css({ ...cardCss, gap: spacing.sm })}
			>
				<h2 mix={css(cardTitleCss)}>
					{group.package ? (
						<a href={group.package.href}>
							<code>{group.package.kodyId}</code>
						</a>
					) : (
						'No longer available'
					)}
				</h2>
				{group.package && group.package.name !== group.package.kodyId ? (
					<p mix={css(smallMutedCss)}>{group.package.name}</p>
				) : null}
				<ul mix={css(listCss)}>
					{group.items.map((item) => renderItem(path, item))}
				</ul>
			</section>
		)
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const path = readBundlePath(currentHref)
		if (!path) return <NotFoundPage />
		const snapshot = bundleData.read(handle, currentHref)
		if (snapshot.kind === 'not-found') return <NotFoundPage />
		if (snapshot.data?.ok === false && !snapshot.stale) {
			if (snapshot.data.reason === 'not-found') return <NotFoundPage />
			return (
				<section mix={css(stackedPageCss)} data-testid="approval-bundle">
					<header mix={css(pageHeaderCss)}>
						<span mix={css(pageEyebrowCss)}>Review approvals</span>
						<h1 mix={css(pageTitleCss)}>This link expired</h1>
						<p mix={css(pageDescriptionCss)}>
							Approval links stop working after 30 days. Anything you already
							approved or denied from this link stays in effect. Ask your agent
							for a new link to review whatever still waits.
						</p>
					</header>
				</section>
			)
		}
		const loaded = snapshot.data?.ok ? snapshot.data.view : null
		if (loaded !== baseView) {
			baseView = loaded
			updated = new Map()
			errors = new Map()
			summary = null
		}
		const view = loaded
		const groups = view ? currentGroups(view) : []
		const remaining = view ? awaitingDecision(view).length : 0
		const ready = view ? readyToApprove(view).length : 0
		const items = groups.flatMap((group) => group.items)
		const allDecided =
			items.length > 0 && items.every((item) => item.decision !== null)

		return (
			<section
				mix={css(stackedPageCss)}
				data-testid="approval-bundle"
				aria-busy={snapshot.kind === 'pending' ? 'true' : undefined}
			>
				<header mix={css(pageHeaderCss)}>
					<span mix={css(pageEyebrowCss)}>Review approvals</span>
					<h1 mix={css(pageTitleCss)}>
						{!view
							? 'Review approvals'
							: remaining > 0
								? remaining === 1
									? '1 change waits for you'
									: `${remaining} changes wait for you`
								: allDecided
									? `All ${items.length} ${items.length === 1 ? 'change is' : 'changes are'} decided`
									: 'Nothing here waits for you'}
					</h1>
					<p mix={css(pageDescriptionCss)}>
						An agent
						{view?.bundle.createdVia
							? ` using ${view.bundle.createdVia}`
							: ''}{' '}
						gathered these for <code>@{path.orgSlug}</code>. Nothing changes
						until you approve. Each approval does exactly what it would on the
						package’s own approval page. Credential values are never shown.
					</p>
				</header>

				{snapshot.kind === 'error' ? (
					<section
						role="alert"
						mix={css({ ...cardCss, borderLeft: `4px solid ${colors.danger}` })}
					>
						<p mix={css({ margin: 0 })}>
							{snapshot.error?.message ??
								'Kody could not load these approvals.'}
						</p>
					</section>
				) : null}
				{!view && snapshot.kind !== 'error' ? (
					<p mix={css(mutedCss)}>Loading the approvals…</p>
				) : null}

				{view?.bundle.note ? (
					<section
						aria-label="Note from your agent"
						data-testid="approval-bundle-note"
						mix={css({ ...cardCss, borderLeft: `4px solid ${colors.border}` })}
					>
						<p mix={css(smallMutedCss)}>
							Note from the agent that made this link (Kody did not write this):
						</p>
						<p mix={css({ margin: 0, whiteSpace: 'pre-wrap' })}>
							{view.bundle.note}
						</p>
					</section>
				) : null}

				{view ? (
					<section
						mix={css({
							display: 'grid',
							gap: spacing.sm,
							justifyItems: 'start',
						})}
					>
						<button
							type="button"
							data-testid="approval-bundle-approve-all"
							disabled={ready === 0 || approveAll !== null}
							mix={[
								css(approveAllButtonCss),
								on('click', () => void runApproveAll(path, view)),
							]}
						>
							{approveAll
								? `Approving ${Math.min(approveAll.done + 1, approveAll.total)} of ${approveAll.total}…`
								: approveAllLabel(ready, remaining)}
						</button>
						{approveAll ? (
							<p mix={css(smallMutedCss)}>
								Publishes can take a moment each. Keep this page open.
							</p>
						) : null}
						{summary ? (
							<p
								role="status"
								data-testid="approval-bundle-summary"
								mix={css({ margin: 0 })}
							>
								{summary}
							</p>
						) : null}
					</section>
				) : null}

				{groups.map((group, index) => renderGroup(path, group, index))}
			</section>
		)
	}
}
