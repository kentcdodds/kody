import { css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import {
	type ApprovalAction,
	type ApprovalView,
	getScopeLabel,
} from '#client/routes/account-approval-shared.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { accountDisclosureCss } from './account-management-components.tsx'

export function renderSecretApprovalCard(props: {
	approvalCard: ApprovalView
	packagesById: ReadonlyMap<string, { kodyId: string; name: string }>
	disabled: boolean
	onSubmit: (action: ApprovalAction) => void
}) {
	const { approvalCard, packagesById, disabled, onSubmit } = props
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
					{approvalCard.requestedHost && !approvalCard.requestedPackageId
						? 'Allow access'
						: 'Approve secret access'}
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
					<p mix={css({ margin: 0, color: colors.textMuted })}>
						Let Kody use this connection at{' '}
						<strong mix={css({ color: colors.text })}>
							{approvalCard.requestedHost}
						</strong>
						.
					</p>
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
				<button
					type="button"
					disabled={disabled}
					mix={[
						on('click', () => onSubmit('approve')),
						css(secretApprovalPrimaryButtonCss),
					]}
				>
					{approvalCard.requestedPackageId && approvalCard.names.length > 1
						? `Approve all (${approvalCard.names.length})`
						: approvalCard.requestedHost && !approvalCard.requestedPackageId
							? 'Allow access'
							: 'Approve'}
				</button>
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
