import { css, ref, type Handle } from 'remix/component'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { on } from '#client/event-mixin.ts'
import { formatTimestampDate } from '#client/format-timestamp.ts'
import { type AccountPackageSecurityAudit } from '#universal/loader-data.ts'
import { packageSecurityAuditAnchor } from '#universal/package-security-audit-prompt.ts'
import { communityStatusPillBoxCss } from '#universal/community-status-pill.ts'
import {
	getGhostButtonCss,
	hoverMq,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

const dialogTitleId = 'package-security-audit-dialog-title'

export function auditedLabel(audit: { recordedAt: string; auditor: string }) {
	return `Audited ${formatTimestampDate(audit.recordedAt)} by ${audit.auditor}`
}

/**
 * Informational audit of the exact published commit + capability set. It
 * never approves anything; the Approve button stays a separate human click.
 */
export function PackageSecurityAuditField(
	handle: Handle<{
		audit: AccountPackageSecurityAudit
		packageName: string
		/** A paused publish of a different commit waits on this page. */
		hasPausedPublish: boolean
	}>,
) {
	let dialogOpen = false
	let dialogNode: HTMLDialogElement | null = null
	let checkedHash = false

	function openDialog() {
		dialogOpen = true
		handle.update()
		if (dialogNode && !dialogNode.open) dialogNode.showModal()
	}

	function closeDialog() {
		dialogOpen = false
		dialogNode?.close()
		handle.update()
	}

	return () => {
		const { audit, packageName, hasPausedPublish } = handle.props
		return (
			<section
				id={packageSecurityAuditAnchor}
				data-testid="package-security-audit"
				data-audit-status={audit.status}
				aria-labelledby="package-security-audit-heading"
				mix={css(fieldCss)}
			>
				<h2 id="package-security-audit-heading" mix={css(fieldLabelCss)}>
					Security audit
				</h2>
				{audit.status === 'unpublished' ? (
					<p mix={css(fieldValueCss)}>
						No security audit performed. Publish this package to audit it.
					</p>
				) : audit.status === 'not_audited' ? (
					<button
						type="button"
						data-testid="package-security-audit-open"
						aria-haspopup="dialog"
						mix={[css(linkButtonCss), on('click', openDialog)]}
					>
						No security audit performed
					</button>
				) : (
					<p mix={css(auditedRowCss)}>
						<span
							data-testid="package-security-audit-verdict"
							mix={css(
								audit.verdict === 'pass' ? passPillCss : concernsPillCss,
							)}
						>
							{audit.verdict === 'pass' ? 'Pass' : 'Concerns'}
						</span>
						<a
							href={`#${packageSecurityAuditAnchor}`}
							data-testid="package-security-audit-open"
							aria-haspopup="dialog"
							mix={[
								css(linkButtonCss),
								on('click', (event) => {
									event.preventDefault()
									openDialog()
								}),
							]}
						>
							{auditedLabel(audit)}
						</a>
					</p>
				)}
				{hasPausedPublish && audit.status !== 'unpublished' ? (
					<p
						data-testid="package-security-audit-paused-note"
						mix={css(fieldNoteCss)}
					>
						Covers the published version only, not the paused publish waiting
						above. Audit that one after it publishes.
					</p>
				) : null}
				<p mix={css(fieldNoteCss)}>
					{audit.status === 'audited'
						? 'Informational only. It covers this published version; a new publish or capability change needs a new audit.'
						: 'Informational only. Have your agent review this version before you approve. It never approves anything for you.'}
				</p>
				{audit.status === 'unpublished' ? null : (
					<dialog
						aria-labelledby={dialogTitleId}
						data-testid="package-security-audit-dialog"
						mix={[
							css(dialogCss),
							ref((node, signal) => {
								if (!(node instanceof HTMLDialogElement)) return
								dialogNode = node
								if (
									!checkedHash &&
									audit.status === 'audited' &&
									window.location.hash === `#${packageSecurityAuditAnchor}`
								) {
									dialogOpen = true
								}
								checkedHash = true
								if (dialogOpen && !node.open) node.showModal()
								signal.addEventListener('abort', () => {
									dialogNode = null
								})
							}),
							on('cancel', (event) => {
								event.preventDefault()
								closeDialog()
							}),
							on('close', () => {
								if (dialogOpen) {
									dialogOpen = false
									handle.update()
								}
							}),
							on('click', (event) => {
								if (event.target === event.currentTarget) closeDialog()
							}),
						]}
					>
						<div mix={css(dialogBodyCss)}>
							{audit.status === 'not_audited' ? (
								<>
									<h3 id={dialogTitleId} mix={css(dialogTitleCss)}>
										Ask your agent for a security audit
									</h3>
									<p mix={css(dialogTextCss)}>
										Copy this prompt into your agent. It reviews this exact
										version of {packageName} and records the result here. The
										audit is informational; you still approve yourself.
									</p>
									<pre
										data-testid="package-security-audit-prompt"
										mix={css(promptCss)}
									>
										{audit.prompt}
									</pre>
									<div mix={css(dialogActionsCss)}>
										<CopyTextButton
											value={audit.prompt}
											idleLabel="Copy prompt"
											ariaLabel="Copy security audit prompt"
											variant="pill"
											size="sm"
										/>
										<button
											type="button"
											data-testid="package-security-audit-close"
											mix={[css(getGhostButtonCss()), on('click', closeDialog)]}
										>
											Close
										</button>
									</div>
								</>
							) : (
								<>
									<h3 id={dialogTitleId} mix={css(dialogTitleCss)}>
										Security audit summary
									</h3>
									<p mix={css(dialogTextCss)}>
										{auditedLabel(audit)}
										{audit.recordedBy
											? ` · recorded by ${audit.recordedBy}`
											: ''}
										{' · '}
										{audit.verdict === 'pass'
											? 'No concerns found'
											: 'Concerns found'}
									</p>
									<p
										data-testid="package-security-audit-summary"
										mix={css(summaryCss)}
									>
										{audit.summary}
									</p>
									<div mix={css(dialogActionsCss)}>
										<button
											type="button"
											data-testid="package-security-audit-close"
											mix={[css(getGhostButtonCss()), on('click', closeDialog)]}
										>
											Close
										</button>
									</div>
								</>
							)}
						</div>
					</dialog>
				)}
			</section>
		)
	}
}

const fieldCss = {
	display: 'grid',
	gap: spacing.xs,
	padding: spacing.md,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
	minWidth: 0,
}

const fieldLabelCss = {
	margin: 0,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.semibold,
	color: colors.textMuted,
	letterSpacing: '0.01em',
}

const fieldValueCss = {
	margin: 0,
	color: colors.text,
	fontSize: typography.fontSize.base,
}

const fieldNoteCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const linkButtonCss = {
	appearance: 'none' as const,
	justifySelf: 'start',
	padding: 0,
	border: 'none',
	background: 'none',
	font: 'inherit',
	fontSize: typography.fontSize.base,
	fontWeight: typography.fontWeight.semibold,
	color: colors.primaryText,
	textAlign: 'start' as const,
	textDecoration: 'underline',
	textUnderlineOffset: '0.2em',
	cursor: 'pointer',
	overflowWrap: 'anywhere' as const,
	[hoverMq]: {
		'&:hover': { color: colors.primaryHover },
	},
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '2px',
		borderRadius: radius.sm,
	},
}

const auditedRowCss = {
	margin: 0,
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	gap: spacing.sm,
	minWidth: 0,
}

const passPillCss = {
	...communityStatusPillBoxCss,
	color: colors.primaryText,
	backgroundColor: colors.primarySoft,
}

const concernsPillCss = {
	...communityStatusPillBoxCss,
	color: colors.warningText,
	backgroundColor: 'color-mix(in srgb, var(--color-warning) 18%, transparent)',
}

const dialogCss = {
	width: 'min(40rem, calc(100vw - 2rem))',
	maxWidth: '40rem',
	padding: 0,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.lg,
	boxShadow: shadows.md,
	backgroundColor: colors.surface,
	color: colors.text,
	'&::backdrop': {
		backgroundColor: 'oklch(0 0 0 / 0.45)',
	},
}

const dialogBodyCss = {
	display: 'grid',
	gap: spacing.md,
	padding: spacing.lg,
	minWidth: 0,
}

const dialogTitleCss = {
	margin: 0,
	fontSize: '1.2rem',
	fontWeight: 720,
	letterSpacing: '-0.014em',
	lineHeight: 1.2,
}

const dialogTextCss = {
	margin: 0,
	color: colors.textMuted,
}

const promptCss = {
	margin: 0,
	maxHeight: 'min(22rem, 45vh)',
	overflow: 'auto',
	padding: spacing.md,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.background,
	fontFamily: typography.fontFamilyMono,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.5,
	whiteSpace: 'pre-wrap' as const,
	overflowWrap: 'anywhere' as const,
}

const summaryCss = {
	margin: 0,
	whiteSpace: 'pre-wrap' as const,
	overflowWrap: 'anywhere' as const,
	lineHeight: 1.55,
}

const dialogActionsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
	alignItems: 'center',
}
