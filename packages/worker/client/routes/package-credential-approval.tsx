// remix-skill: bundled credential mapping approval (`/@user/name/approve-credentials?<proposal>`).
import { type Handle, type RemixNode, css } from 'remix/component'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { on } from '#client/event-mixin.ts'
import { NotFoundPage } from '#client/not-found-page.tsx'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import {
	type RouteLoaderResult,
	routeLoaderRedirect,
} from '#client/route-loader.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	type CredentialApprovalChangeView,
	type CredentialApprovalEnableView,
	type CredentialApprovalFailure,
	type CredentialApprovalSuccess,
	type CredentialApprovalView,
} from '#universal/credential-contracts.ts'
import { credentialKindLabel } from '#universal/credentials-list.ts'
import {
	type CredentialApprovalGroup,
	type PackageCredentialApprovalLoaderData,
	approvalAfterLabel,
	approvalBeforeLabel,
	approvalChangeIsNoop,
	approvalDoneCopy,
	approvalEnableStatus,
	approvalProblems,
	approvalSummary,
	credentialApprovalAgentPrompt,
	groupApprovalChanges,
} from '#universal/package-credential-approval-page.ts'
import { describeTrigger } from '#universal/package-credentials-page.ts'
import { routes } from '#universal/routes.ts'
import {
	cardCss,
	cardTitleCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	insetCardCss,
	pageDescriptionCss,
	pageEyebrowCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

const primaryButtonCss = getPrimaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})
const secondaryButtonCss = getSecondaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})
const mutedCss = { margin: 0, color: colors.textMuted }
const listCss = {
	margin: 0,
	padding: 0,
	listStyle: 'none',
	display: 'grid',
	gap: spacing.sm,
}

type ApprovalPath = { username: string; kodyId: string; search: string }

function readApprovalPath(href: string): ApprovalPath | null {
	const url = new URL(href, 'http://localhost')
	const match = /^\/@([^/]+)\/([^/]+)\/approve-credentials\/?$/.exec(
		url.pathname,
	)
	if (!match || match[2] === '-') return null
	try {
		return {
			username: decodeURIComponent(match[1]!),
			kodyId: decodeURIComponent(match[2]!),
			search: url.search,
		}
	} catch {
		return null
	}
}

function approvalApiHref(path: ApprovalPath) {
	return `${routes.communityPackageApproveCredentialsApi.href({
		username: path.username,
		kodyId: path.kodyId,
	})}${path.search}`
}

function loginRedirect(href: string) {
	return `/login?redirectTo=${encodeURIComponent(href)}`
}

type ApprovalLoadResult =
	| { kind: 'data'; data: PackageCredentialApprovalLoaderData }
	| { kind: 'redirect'; to: string }

export async function loadCredentialApproval(
	href: string,
	signal: AbortSignal,
): Promise<ApprovalLoadResult> {
	const path = readApprovalPath(href)
	if (!path) return { kind: 'data', data: { ok: false, notFound: true } }
	const response = await fetch(approvalApiHref(path), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		const url = new URL(href, 'http://localhost')
		return {
			kind: 'redirect',
			to: loginRedirect(`${url.pathname}${url.search}`),
		}
	}
	if (response.status === 404) {
		return { kind: 'data', data: { ok: false, notFound: true } }
	}
	const view = await readJson<CredentialApprovalView>(response)
	if (!response.ok || !view?.ok) {
		throw new Error(
			`Kody could not load this approval (HTTP ${response.status}).`,
		)
	}
	return { kind: 'data', data: { ok: true, view } }
}

export async function packageCredentialApprovalRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const result = await loadCredentialApproval(
		`${url.pathname}${url.search}`,
		signal,
	)
	return result.kind === 'redirect'
		? routeLoaderRedirect(result.to)
		: { packageCredentialApproval: result.data }
}

function needSummary(change: CredentialApprovalChangeView) {
	if (!change.need) return null
	const parts = [
		change.need.kind ? credentialKindLabel(change.need.kind) : 'Any kind',
		change.need.provider,
	]
	if (change.need.multiple) parts.push('several allowed')
	return parts.join(' · ')
}

function renderChange(
	change: CredentialApprovalChangeView,
	index: number,
	approved: boolean,
) {
	const noop = !approved && approvalChangeIsNoop(change)
	return (
		<li
			key={index}
			data-testid={`approval-change-${index}`}
			mix={css({
				...insetCardCss,
				display: 'grid',
				gap: spacing.xs,
				borderLeft: change.error ? `4px solid ${colors.danger}` : undefined,
			})}
		>
			<div
				mix={css({
					display: 'flex',
					flexWrap: 'wrap',
					gap: spacing.sm,
					alignItems: 'baseline',
				})}
			>
				<strong>{change.needKey}</strong>
				{needSummary(change) ? (
					<span mix={css({ ...mutedCss, fontSize: typography.fontSize.sm })}>
						{needSummary(change)}
					</span>
				) : null}
			</div>
			{change.need?.description ? (
				<p mix={css(mutedCss)}>{change.need.description}</p>
			) : null}
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
				{approved ? (
					<>
						<dt>Saved</dt>
						<dd>
							<strong>{approvalAfterLabel(change)}</strong>
						</dd>
					</>
				) : (
					<>
						<dt>Now</dt>
						<dd>{approvalBeforeLabel(change)}</dd>
						<dt>After</dt>
						<dd>
							<strong>{approvalAfterLabel(change)}</strong>
							{noop ? <span mix={css(mutedCss)}> (no change)</span> : null}
						</dd>
					</>
				)}
			</dl>
			{!approved && change.willEnable && change.target.type === 'trigger' ? (
				<p mix={css({ margin: 0, color: colors.warningText })}>
					Approving turns on {describeTrigger(change.target.trigger)} for you.
				</p>
			) : null}
			{change.error ? (
				<p
					data-testid="approval-change-error"
					mix={css({ margin: 0, color: colors.danger })}
				>
					{change.error.message}
					{change.error.createUrl ? (
						<>
							{' '}
							<a href={change.error.createUrl}>Add a credential</a>
						</>
					) : null}
				</p>
			) : null}
		</li>
	)
}

function renderEnable(
	entry: CredentialApprovalEnableView,
	index: number,
	approved: boolean,
	turnedOn: boolean,
) {
	const label = describeTrigger(entry.trigger)
	const status = approvalEnableStatus(entry, { approved, turnedOn })
	return (
		<li
			key={`${entry.trigger.kind}:${entry.trigger.name}`}
			data-testid={`approval-enable-${index}`}
			mix={css({
				...insetCardCss,
				display: 'grid',
				gap: spacing.xs,
				borderLeft: entry.error ? `4px solid ${colors.danger}` : undefined,
			})}
		>
			<strong>{label}</strong>
			{status ? (
				<p
					mix={css(
						entry.willEnable || turnedOn
							? { margin: 0, color: colors.warningText }
							: mutedCss,
					)}
				>
					{status}
				</p>
			) : null}
			{entry.error ? (
				<p
					data-testid="approval-enable-error"
					mix={css({ margin: 0, color: colors.danger })}
				>
					{entry.error.message}
				</p>
			) : null}
		</li>
	)
}

function renderGroup(
	group: CredentialApprovalGroup,
	approved: boolean,
): RemixNode {
	return (
		<section
			key={group.key}
			aria-label={group.title}
			mix={css({ display: 'grid', gap: spacing.sm })}
		>
			<div mix={css({ display: 'grid', gap: spacing.xs })}>
				<h2 mix={css(cardTitleCss)}>{group.title}</h2>
				<p mix={css(mutedCss)}>{group.description}</p>
			</div>
			<ul mix={css(listCss)}>
				{group.changes.map(({ change, index }) =>
					renderChange(change, index, approved),
				)}
			</ul>
		</section>
	)
}

export function PackageCredentialApprovalRoute(handle: Handle) {
	let latest: {
		base: CredentialApprovalView
		view: CredentialApprovalView
		/** The view on screen when Approve was clicked. */
		submitted: CredentialApprovalView
	} | null = null
	let baseView: CredentialApprovalView | null = null
	let approving = false
	let approved = false
	let message: string | null = null

	const approvalData = createRouteData<
		'packageCredentialApproval',
		PackageCredentialApprovalLoaderData
	>({
		key: 'packageCredentialApproval',
		fromLoaderData: (payload) => payload,
		async load(href, signal) {
			const result = await loadCredentialApproval(href, signal)
			return result.kind === 'redirect'
				? routeDataRedirect(result.to)
				: result.data
		},
	})

	async function approve(path: ApprovalPath, view: CredentialApprovalView) {
		if (approving || !view.canApprove || !baseView) return
		const base = baseView
		approving = true
		message = null
		handle.update()
		const response = await fetch(
			`${routes.communityPackageApproveCredentialsApiPost.href({
				username: path.username,
				kodyId: path.kodyId,
			})}${path.search}`,
			{
				method: 'POST',
				credentials: 'include',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					action: 'approve',
					fingerprint: view.fingerprint,
				}),
			},
		).catch(() => null)
		approving = false
		if (!response) {
			message = 'Kody could not be reached. Try again.'
			handle.update()
			return
		}
		if (response.status === 401) {
			window.location.assign(
				loginRedirect(`${window.location.pathname}${window.location.search}`),
			)
			return
		}
		const payload = await readJson<
			| CredentialApprovalSuccess
			| CredentialApprovalFailure
			| { ok: false; error?: string }
		>(response)
		if (payload && 'view' in payload) {
			latest = { base, view: payload.view, submitted: view }
		}
		if (response.ok && payload?.ok) {
			approved = true
		} else {
			message =
				(payload && !payload.ok ? payload.error : null) ||
				`Kody could not approve these mappings (HTTP ${response.status}).`
		}
		handle.update()
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const path = readApprovalPath(currentHref)
		if (!path) return <NotFoundPage />
		const snapshot = approvalData.read(handle, currentHref)
		if (
			snapshot.kind === 'not-found' ||
			(snapshot.data?.ok === false && !snapshot.stale)
		) {
			return <NotFoundPage />
		}
		const loaded = snapshot.data?.ok ? snapshot.data.view : null
		if (loaded !== baseView) {
			baseView = loaded
			approved = false
			message = null
		}
		const current = loaded && latest?.base === loaded ? latest : null
		const view = current ? current.view : loaded
		const reviewed = current ? current.submitted : loaded
		const pageUrl =
			typeof window === 'undefined'
				? currentHref
				: new URL(currentHref, window.location.origin).href
		const packageName = `@${path.username}/${path.kodyId}`
		const credentialsHref = routes.communityPackageCredentials.href({
			username: path.username,
			kodyId: path.kodyId,
		})
		const problems = view ? approvalProblems(view) : []
		const promptProblems = message ? [message, ...problems] : problems

		return (
			<section
				mix={css(stackedPageCss)}
				data-testid="credential-approval"
				aria-busy={snapshot.kind === 'pending' ? 'true' : undefined}
			>
				<header mix={css(pageHeaderCss)}>
					<span mix={css(pageEyebrowCss)}>Approve credential mappings</span>
					<h1 mix={css(pageTitleCss)}>
						Choose credentials for <code>{packageName}</code>
					</h1>
					<p mix={css(pageDescriptionCss)}>
						Review which credential each need of this package will use. Nothing
						changes until you approve, and approving saves every change below at
						once. Credential values are never shown.
					</p>
				</header>

				{snapshot.kind === 'error' ? (
					<section
						role="alert"
						mix={css({
							...cardCss,
							borderLeft: `4px solid ${colors.danger}`,
							justifyItems: 'start',
						})}
					>
						<p mix={css({ margin: 0 })}>
							{snapshot.error?.message ?? 'Kody could not load this approval.'}
						</p>
						<CopyTextButton
							value={credentialApprovalAgentPrompt({
								pageUrl,
								problems: [
									snapshot.error?.message ?? 'The approval did not load.',
								],
							})}
							idleLabel="Copy prompt for your agent"
						/>
					</section>
				) : null}
				{!view && snapshot.kind !== 'error' ? (
					<p mix={css(mutedCss)}>Loading the proposed mappings…</p>
				) : null}

				{view?.reason ? (
					<section
						aria-label="Note from your agent"
						data-testid="credential-approval-reason"
						mix={css({ ...cardCss, borderLeft: `4px solid ${colors.border}` })}
					>
						<p mix={css({ ...mutedCss, fontSize: typography.fontSize.sm })}>
							Note from the agent that made this link (Kody did not write this):
						</p>
						<p mix={css({ margin: 0, whiteSpace: 'pre-wrap' })}>
							{view.reason}
						</p>
					</section>
				) : null}

				{approved && view && reviewed ? (
					<section
						role="status"
						data-testid="credential-approval-done"
						mix={css({ ...cardCss, borderLeft: `4px solid ${colors.primary}` })}
					>
						<h2 mix={css(cardTitleCss)}>Approved</h2>
						<p mix={css({ margin: 0 })}>
							{approvalDoneCopy(reviewed)}
							{view.changes.length > 0 ? (
								<>
									{' '}
									Runs of <code>{packageName}</code> use them from now on.
								</>
							) : null}
						</p>
						<a href={credentialsHref}>See this package’s credentials</a>
					</section>
				) : null}

				{view && view.errors.length > 0 ? (
					<section
						role="alert"
						data-testid="credential-approval-errors"
						mix={css({ ...cardCss, borderLeft: `4px solid ${colors.danger}` })}
					>
						<h2 mix={css(cardTitleCss)}>This link has problems</h2>
						<ul mix={css({ margin: 0, paddingLeft: spacing.lg })}>
							{view.errors.map((error) => (
								<li key={error}>{error}</li>
							))}
						</ul>
					</section>
				) : null}

				{view &&
				view.changes.length === 0 &&
				view.enable.length === 0 &&
				view.errors.length === 0 ? (
					<section mix={css(cardCss)}>
						<p mix={css({ margin: 0 })}>
							This link proposes no mappings or triggers to turn on. Ask your
							agent for a new link.
						</p>
					</section>
				) : null}

				{view && view.changes.length > 0 ? (
					<section mix={css({ ...cardCss, gap: spacing.lg })}>
						{groupApprovalChanges(view.changes).map((group) =>
							renderGroup(group, approved),
						)}
					</section>
				) : null}

				{view && view.enable.length > 0 ? (
					<section
						aria-label="Triggers to turn on"
						mix={css({ ...cardCss, gap: spacing.sm })}
					>
						<div mix={css({ display: 'grid', gap: spacing.xs })}>
							<h2 mix={css(cardTitleCss)}>Turn on</h2>
							<p mix={css(mutedCss)}>
								Triggers this link turns on for you. Their credentials are not
								changed.
							</p>
						</div>
						<ul mix={css(listCss)}>
							{view.enable.map((entry, index) =>
								renderEnable(
									entry,
									index,
									approved,
									approved &&
										(reviewed?.enable.some(
											(candidate) =>
												candidate.willEnable &&
												candidate.trigger.kind === entry.trigger.kind &&
												candidate.trigger.name === entry.trigger.name,
										) ??
											false),
								),
							)}
						</ul>
					</section>
				) : null}

				{view &&
				!approved &&
				(view.changes.length > 0 ||
					view.enable.length > 0 ||
					problems.length > 0) ? (
					<section
						mix={css({
							display: 'grid',
							gap: spacing.sm,
							justifyItems: 'start',
						})}
					>
						{message ? (
							<p
								role="alert"
								data-testid="credential-approval-message"
								mix={css({ margin: 0, color: colors.danger })}
							>
								{message}
							</p>
						) : null}
						{!view.canApprove ? (
							<p mix={css(mutedCss)}>
								Fix the problems above before approving. Your agent can make a
								corrected link.
							</p>
						) : null}
						{promptProblems.length > 0 ? (
							<CopyTextButton
								value={credentialApprovalAgentPrompt({
									pageUrl,
									problems: promptProblems,
								})}
								idleLabel="Copy prompt for your agent"
							/>
						) : null}
						<div
							mix={css({ display: 'flex', flexWrap: 'wrap', gap: spacing.sm })}
						>
							<button
								type="button"
								data-testid="credential-approval-approve"
								disabled={!view.canApprove || approving}
								mix={[
									css(primaryButtonCss),
									on('click', () => void approve(path, view)),
								]}
							>
								{approving ? 'Approving…' : approvalSummary(view)}
							</button>
							<a
								href={credentialsHref}
								mix={css({
									...secondaryButtonCss,
									display: 'inline-flex',
									textDecoration: 'none',
								})}
							>
								Cancel
							</a>
						</div>
					</section>
				) : null}
			</section>
		)
	}
}
