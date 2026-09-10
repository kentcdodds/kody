import { type AccountSecretsLoaderData } from '#universal/loader-data.ts'
import { parseAccountSecretPath } from '@kody-internal/shared/account-secret-route.ts'
import { css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import {
	type ApprovalAction,
	type ApprovalView,
	allowHostsButtonLabel,
	allowPackagesButtonLabel,
	approvalRejectedHosts,
	approvalRequestedHosts,
	getScopeLabel,
} from '#client/routes/account-approval-shared.ts'
import { routes } from '#universal/routes.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	cardCss,
	getAccentCalloutCss,
	getGhostButtonCss,
	getPillButtonCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	pageDescriptionCss,
	pageEyebrowCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import { accountDisclosureCss } from './account-management-components.tsx'

export function renderSecretApprovalCard(props: {
	approvalCard: ApprovalView
	packagesById: ReadonlyMap<string, { kodyId: string; name: string }>
	disabled: boolean
	onSubmit: (action: ApprovalAction) => void
}) {
	const { approvalCard, packagesById, disabled, onSubmit } = props
	const hosts = approvalHosts(approvalCard)
	const rejectedHosts = approvalRejectedHosts(approvalCard)
	const requestedPackageMetadata = approvalCard.requestedPackageId
		? packagesById.get(approvalCard.requestedPackageId)
		: null
	return (
		<section
			mix={css({
				display: 'grid',
				gap: spacing.md,
				padding: spacing.lg,
				borderRadius: radius.lg,
				border: `1px solid ${colors.primary}`,
				backgroundColor: colors.primarySoftest,
			})}
		>
			<div mix={css({ display: 'grid', gap: spacing.xs })}>
				<h2
					mix={css({
						margin: 0,
						fontSize: typography.fontSize.lg,
						fontWeight: typography.fontWeight.semibold,
						color: colors.text,
					})}
				>
					{approvalCard.requestedPackageId
						? 'Allow package access'
						: 'Allow access'}
				</h2>
				{approvalCard.requestedPackageId ? (
					<div mix={css({ display: 'grid', gap: spacing.xs })}>
						<p mix={css({ margin: 0, color: colors.textMuted })}>
							Allow package{' '}
							<strong mix={css({ color: colors.text })}>
								{requestedPackageMetadata?.kodyId ?? 'Unknown package'}
							</strong>{' '}
							{approvalCard.names.length > 1 ? (
								<>
									to use these {approvalCard.names.length} secrets from the{' '}
									{getScopeLabel(approvalCard.scope)} scope.
								</>
							) : (
								<>
									to use secret <code>{approvalCard.name}</code> from the{' '}
									{getScopeLabel(approvalCard.scope)} scope.
								</>
							)}
						</p>
						<code mix={css({ color: colors.textMuted })}>
							{approvalCard.requestedPackageId}
						</code>
						{approvalCard.names.length > 1 ? (
							<ul
								mix={css({
									margin: 0,
									paddingLeft: spacing.lg,
									display: 'grid',
									gap: spacing.xs,
								})}
							>
								{approvalCard.names.map((secretName) => (
									<li key={secretName}>
										<code>{secretName}</code>
									</li>
								))}
							</ul>
						) : null}
					</div>
				) : (
					<div mix={css({ display: 'grid', gap: spacing.xs })}>
						<p mix={css({ margin: 0, color: colors.textMuted })}>
							{hosts.length > 1
								? 'Let Kody use this secret at these hosts.'
								: hosts.length === 1
									? 'Let Kody use this connection at '
									: 'This approval link did not include a valid host.'}
							{hosts.length === 1 ? (
								<strong mix={css({ color: colors.text })}>{hosts[0]}</strong>
							) : null}
							{hosts.length === 1 ? '.' : null}
						</p>
						{hosts.length > 1 ? (
							<ul
								mix={css({
									margin: 0,
									paddingLeft: spacing.lg,
									display: 'grid',
									gap: spacing.xs,
								})}
							>
								{hosts.map((host) => (
									<li key={host}>
										<strong mix={css({ color: colors.text })}>{host}</strong>
									</li>
								))}
							</ul>
						) : null}
						{rejectedHosts.length > 0 ? (
							<div
								mix={css(getAccentCalloutCss({ accentColor: colors.danger }))}
								data-testid="secret-approval-rejected-hosts"
							>
								<span mix={css({ color: colors.danger, fontWeight: 600 })}>
									{rejectedHosts.length === 1
										? 'This host is not valid'
										: `${rejectedHosts.length} hosts are not valid`}
								</span>
								<ul
									mix={css({
										margin: 0,
										paddingLeft: spacing.lg,
										display: 'grid',
										gap: spacing.xs,
									})}
								>
									{rejectedHosts.map((entry) => (
										<li key={entry.host}>
											<strong mix={css({ color: colors.text })}>
												{entry.host}
											</strong>
											<span mix={css({ color: colors.textMuted })}>
												{' '}
												— {entry.message}
											</span>
										</li>
									))}
								</ul>
							</div>
						) : null}
					</div>
				)}
				{approvalCard.requestedPackageId ? (
					approvalCard.names.length > 1 ? null : (
						<div mix={css({ display: 'grid', gap: spacing.xs })}>
							<span mix={css({ color: colors.textMuted })}>
								Current allowed packages:
							</span>
							{approvalCard.currentAllowedPackages.length > 0 ? (
								<ul
									mix={css({
										margin: 0,
										paddingLeft: spacing.lg,
										display: 'grid',
										gap: spacing.xs,
									})}
								>
									{approvalCard.currentAllowedPackages.map((packageId) => {
										const metadata = packagesById.get(packageId)
										return (
											<li key={packageId}>
												<span mix={css(secretPackageIdentityCss)}>
													<strong>
														{metadata?.kodyId ?? 'Unknown package'}
													</strong>
													<code>{packageId}</code>
												</span>
											</li>
										)
									})}
								</ul>
							) : (
								<span mix={css({ color: colors.textMuted })}>None</span>
							)}
						</div>
					)
				) : (
					<details
						mix={css(secretApprovalAdvancedCss)}
						data-testid="secret-approval-advanced"
					>
						<summary>Advanced details</summary>
						<p mix={css({ margin: 0, color: colors.textMuted })}>
							Secret <code>{approvalCard.name}</code>
							{approvalCard.currentAllowedHosts.length > 0
								? ` · already allowed: ${approvalCard.currentAllowedHosts.join(', ')}`
								: ''}
						</p>
					</details>
				)}
			</div>
			<div mix={css({ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' })}>
				{approvalCard.requestedPackageId || hosts.length > 0 ? (
					<button
						type="button"
						disabled={disabled}
						mix={[
							on('click', () => onSubmit('approve')),
							css(secretApprovalPrimaryButtonCss),
						]}
					>
						{approvalCard.requestedPackageId
							? allowPackagesButtonLabel(approvalCard.names.length)
							: allowHostsButtonLabel(hosts.length, rejectedHosts.length)}
					</button>
				) : null}
				<button
					type="button"
					disabled={disabled}
					mix={[
						on('click', () => onSubmit('reject')),
						css(secretApprovalSecondaryButtonCss),
					]}
				>
					Reject
				</button>
			</div>
		</section>
	)
}

function approvalHosts(approvalCard: ApprovalView) {
	return approvalRequestedHosts(approvalCard)
}

export function renderAlreadyAddedNotice(items: Array<string>) {
	return (
		<section
			role="status"
			mix={css({
				display: 'grid',
				gap: spacing.sm,
				padding: spacing.lg,
				borderRadius: radius.lg,
				border: `1px solid ${colors.primary}`,
				backgroundColor: colors.primarySoftest,
			})}
		>
			<div mix={css({ display: 'grid', gap: spacing.xs })}>
				<h2
					mix={css({
						margin: 0,
						fontSize: typography.fontSize.lg,
						fontWeight: typography.fontWeight.semibold,
						color: colors.text,
					})}
				>
					Already added
				</h2>
				<p mix={css({ margin: 0, color: colors.textMuted })}>
					This request is already complete for this secret.
				</p>
			</div>
			<ul
				mix={css({
					margin: 0,
					paddingLeft: spacing.lg,
					color: colors.textMuted,
					display: 'grid',
					gap: spacing.xs,
				})}
			>
				{items.map((item) => (
					<li key={item}>{item}</li>
				))}
			</ul>
		</section>
	)
}

export const secretPackageIdentityCss = {
	display: 'grid',
	gap: spacing.xs,
	minWidth: 0,
	'& code': {
		color: colors.textMuted,
		overflowWrap: 'anywhere' as const,
	},
}

const secretApprovalPrimaryButtonCss = getPillButtonCss({ size: 'sm' })
const secretApprovalSecondaryButtonCss = getGhostButtonCss({ size: 'sm' })

const secretApprovalAdvancedCss = {
	...accountDisclosureCss,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const packageApprovalPageCss = {
	...stackedPageCss,
	maxWidth: '32rem',
	margin: '0 auto',
}

const packageApprovalHeaderCss = {
	...pageHeaderCss,
	justifyItems: 'center',
	textAlign: 'center' as const,
}

const packageApprovalPrimaryButtonCss = getPrimaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})

const packageApprovalSecondaryButtonCss = getSecondaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})

export function isPackageApprovalHref(href: string) {
	const url = new URL(href, 'http://localhost')
	if (url.pathname === routes.accountSecretsApprove.href()) return true
	if (!url.searchParams.get('package_id')?.trim()) return false
	return parseAccountSecretPath(url.pathname)?.scope === 'user'
}

export function isPackageSecretApprovalAlreadyGranted(input: {
	secrets: AccountSecretsLoaderData['secrets']
	approval: ApprovalView
}) {
	const packageId = input.approval.requestedPackageId?.trim()
	if (!packageId || input.approval.names.length === 0) return false
	return input.approval.names.every((name) =>
		input.secrets.some(
			(item) =>
				item.name === name &&
				item.scope === input.approval.scope &&
				item.allowedPackages.includes(packageId),
		),
	)
}

export function readPackageSecretApprovalView(input: {
	completed: ApprovalAction | null
	alreadyGranted: boolean
}) {
	const fullyAllowed = input.completed === 'approve' || input.alreadyGranted
	return {
		fullyAllowed,
		showBackToSecrets: fullyAllowed || input.completed === 'reject',
	}
}

export function renderPackageSecretApprovalPage(props: {
	approval: ApprovalView | null
	approvalError: string | null
	packagesById: ReadonlyMap<string, { kodyId: string; name: string }>
	completed: ApprovalAction | null
	alreadyGranted: boolean
	submittingAction: ApprovalAction | null
	message: string | null
	onSubmit: (action: ApprovalAction) => void
}) {
	const {
		approval,
		approvalError,
		packagesById,
		completed,
		alreadyGranted,
		submittingAction,
		message,
		onSubmit,
	} = props
	const view = readPackageSecretApprovalView({
		completed,
		alreadyGranted,
	})
	const names = approval?.names.length
		? approval.names
		: approval?.name
			? [approval.name]
			: []
	const packageId = approval?.requestedPackageId ?? null
	const packageLabel = packageId
		? (packagesById.get(packageId)?.kodyId ?? packageId)
		: null

	return (
		<section
			mix={css(packageApprovalPageCss)}
			data-testid="account-secrets-package-approval"
		>
			<header mix={css(packageApprovalHeaderCss)}>
				<span mix={css(pageEyebrowCss)}>Allow secret packages</span>
				<h1 mix={css(pageTitleCss)}>
					{view.fullyAllowed
						? 'Access allowed'
						: completed === 'reject'
							? 'Request rejected'
							: 'Allow this package to use these secrets'}
				</h1>
				<p mix={css(pageDescriptionCss)}>
					{view.fullyAllowed
						? 'This package can use the saved secrets below.'
						: completed === 'reject'
							? 'No package grant was added. You can allow later from this same link.'
							: approval
								? 'Kody only grants a user secret to a package you allow. Agents cannot do this for you.'
								: 'Open an approval link from Kody to allow a saved package to use a secret.'}
				</p>
			</header>

			{approvalError ? (
				<section
					mix={css({
						...cardCss,
						border: `1px solid ${colors.danger}`,
					})}
					data-testid="account-secrets-package-approval-error"
				>
					<p mix={css({ margin: 0, color: colors.danger })}>{approvalError}</p>
				</section>
			) : null}

			{message ? (
				<p mix={css({ margin: 0, color: colors.danger })}>{message}</p>
			) : null}

			{approval && packageId ? (
				<section
					mix={css(cardCss)}
					data-testid="account-secrets-package-approval-card"
				>
					<div mix={css({ display: 'grid', gap: spacing.sm })}>
						<div mix={css({ display: 'grid', gap: spacing.xs })}>
							<span mix={css({ color: colors.textMuted })}>
								{names.length === 1 ? 'Secret' : 'Secrets'}
							</span>
							<ul
								mix={css({
									margin: 0,
									paddingLeft: spacing.lg,
									display: 'grid',
									gap: spacing.xs,
								})}
							>
								{names.map((name) => (
									<li key={name}>
										<code>{name}</code>
									</li>
								))}
							</ul>
						</div>
						<div mix={css({ display: 'grid', gap: spacing.xs })}>
							<span mix={css({ color: colors.textMuted })}>Package</span>
							<strong mix={css({ color: colors.text })}>{packageLabel}</strong>
						</div>
					</div>
					{view.showBackToSecrets ? (
						<a
							href={routes.accountSecrets.href()}
							mix={css(packageApprovalSecondaryButtonCss)}
						>
							Back to secrets
						</a>
					) : (
						<div
							mix={css({
								display: 'flex',
								gap: spacing.sm,
								flexWrap: 'wrap',
							})}
						>
							{completed !== 'approve' ? (
								<button
									type="button"
									disabled={submittingAction != null}
									mix={[
										on('click', () => {
											onSubmit('approve')
										}),
										css(packageApprovalPrimaryButtonCss),
									]}
									data-testid="allow-secret-package"
								>
									{submittingAction === 'approve'
										? 'Allowing access…'
										: allowPackagesButtonLabel(names.length)}
								</button>
							) : null}
							<button
								type="button"
								disabled={submittingAction != null}
								mix={[
									on('click', () => {
										onSubmit('reject')
									}),
									css(packageApprovalSecondaryButtonCss),
								]}
							>
								Reject
							</button>
						</div>
					)}
				</section>
			) : null}
		</section>
	)
}
