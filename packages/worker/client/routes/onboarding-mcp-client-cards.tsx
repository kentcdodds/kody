import { type Handle, css } from 'remix/ui'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { colors, radius, typography } from '#universal/styles/tokens.ts'
import {
	getAccentCalloutCss,
	getPillButtonCss,
	mutedLinkCss,
	nativeDisclosureCss,
} from '#universal/styles/style-primitives.ts'
import { renderHighlightedCode } from '#client/syntax-highlight.tsx'
import {
	highlightSnippetKey,
	plainHighlightedCode,
	type HighlightedCode,
} from '#universal/highlighted-code.ts'

type CopyCardProps = {
	label: string
	value: string
	copyLabel: string
	variant?: 'pill' | 'ghost'
	lang?: string | null
	highlights?: Record<string, HighlightedCode>
}

/**
 * Config snippet, ported from the prototype's `.snippet`: a labeled well on
 * the page ground with an uppercase display-face label and its copy button in
 * the header row. `pill` maps to the redesign's green pill; `ghost` is the
 * default and stays the quiet bordered button for follow-up copies.
 */
export function CopyCard(handle: Handle<CopyCardProps>) {
	return () => (
		<div mix={css(snippetCss)}>
			<div mix={css(snippetHeadCss)}>
				<span mix={css(snippetLabelCss)}>{handle.props.label}</span>
				<div mix={css(snippetActionCss)}>
					<CopyTextButton
						value={handle.props.value}
						idleLabel={handle.props.copyLabel}
						variant={handle.props.variant ?? 'ghost'}
					/>
				</div>
			</div>
			<div mix={css(snippetPreCss)}>
				{renderHighlightedCode(
					handle.props.highlights?.[
						highlightSnippetKey({
							code: handle.props.value,
							lang: handle.props.lang,
						})
					] ?? plainHighlightedCode(handle.props.value, handle.props.lang),
				)}
			</div>
		</div>
	)
}

type CopyCardDetailsProps = CopyCardProps & {
	summaryLead: string
	summaryCode?: string
}

/**
 * Collapsed manual snippet: the lead sentence is the summary, the copy
 * well sits inside. Closed unless the caller sets `open` on `<details>`.
 */
export function CopyCardDetails(handle: Handle<CopyCardDetailsProps>) {
	return () => (
		<details
			data-testid="onboarding-mcp-manual-json"
			mix={css(nativeDisclosureCss)}
		>
			<summary>
				{handle.props.summaryLead}
				{handle.props.summaryCode ? (
					<>
						{' '}
						<code>{handle.props.summaryCode}</code>
					</>
				) : null}
				:
			</summary>
			<div>
				<CopyCard
					highlights={handle.props.highlights}
					label={handle.props.label}
					value={handle.props.value}
					copyLabel={handle.props.copyLabel}
					lang={handle.props.lang}
					variant={handle.props.variant}
				/>
			</div>
		</details>
	)
}

type AppIconCardProps = {
	src: string
	downloadName: string
}

/**
 * ChatGPT wants a PNG you can upload. Render the icon so right-click /
 * long-press Save as works, and keep a same-origin download link.
 */
export function AppIconCard(handle: Handle<AppIconCardProps>) {
	return () => (
		<div data-testid="onboarding-mcp-app-icon" mix={css(snippetCss)}>
			<div mix={css(appIconBodyCss)}>
				<img
					src={handle.props.src}
					alt="Kody app icon"
					width={256}
					height={256}
					mix={css(appIconImgCss)}
				/>
				<a
					href={handle.props.src}
					download={handle.props.downloadName}
					mix={css(mutedLinkCss)}
				>
					Download App Icon
				</a>
				<p mix={css(appIconHintCss)}>
					Right-click the icon and choose Save as (on a phone, long-press), then
					upload it in ChatGPT. Icons over 10 KB are rejected.
				</p>
			</div>
		</div>
	)
}

type ClientWarningProps = {
	children: string
}

/** Quiet danger note — red accent, not the green authenticate well. */
export function ClientWarning(handle: Handle<ClientWarningProps>) {
	return () => (
		<p
			mix={css(clientDangerCss)}
			role="note"
			data-testid="onboarding-agent-warning"
		>
			{handle.props.children}
		</p>
	)
}

type ChatGptDeveloperModeWarningProps = {
	href: string
	linkLabel: string
}

/**
 * Amber caution for ChatGPT: developer mode is required. Same quiet
 * callout language as {@link ClientWarning}, warning tone instead of danger.
 */
export function ChatGptDeveloperModeWarning(
	handle: Handle<ChatGptDeveloperModeWarningProps>,
) {
	return () => (
		<p mix={css(clientCautionCss)} role="note">
			ChatGPT developer mode is required. See{' '}
			<a
				href={handle.props.href}
				target="_blank"
				rel="noreferrer noopener"
				data-testid="onboarding-agent-help"
			>
				{handle.props.linkLabel}
			</a>
			.
		</p>
	)
}

export function PrimaryActionLink(
	handle: Handle<{
		href: string
		label: string
		external?: boolean
	}>,
) {
	return () => (
		<div mix={css(deepLinkCss)}>
			<a
				href={handle.props.href}
				target={handle.props.external ? '_blank' : undefined}
				rel={handle.props.external ? 'noreferrer noopener' : undefined}
				mix={css(deepLinkButtonCss)}
			>
				{handle.props.label}
			</a>
		</div>
	)
}

export function InstallDeepLink(
	handle: Handle<{
		href: string
		label: 'Add to Cursor' | 'Add to VS Code'
	}>,
) {
	return () => (
		<div mix={css(deepLinkCss)}>
			<a href={handle.props.href} mix={css(deepLinkButtonCss)}>
				{handle.props.label}
			</a>
			<small mix={css(deepLinkNoteCss)}>
				Your client will still ask you to authorize access afterwards.
			</small>
		</div>
	)
}

export function PluginPrimaryInstall(
	handle: Handle<{
		href: string
		label: 'Add to Cursor' | 'Add to Grok Bot'
		alternativeValue?: string
		alternativeCopyLabel?: string
	}>,
) {
	return () => (
		<div data-testid="onboarding-mcp-plugin-primary" mix={css(deepLinkCss)}>
			<a href={handle.props.href} mix={css(deepLinkButtonCss)}>
				{handle.props.label}
			</a>
			{handle.props.alternativeValue ? (
				<p
					data-testid="onboarding-mcp-plugin-alternative"
					mix={css(pluginAlternativeCss)}
				>
					Or do this: <code>{handle.props.alternativeValue}</code>
					<CopyTextButton
						value={handle.props.alternativeValue}
						idleLabel="Copy"
						variant="chip"
						ariaLabel={handle.props.alternativeCopyLabel}
					/>
				</p>
			) : null}
			<small mix={css(deepLinkNoteCss)}>
				Your client will still ask you to authorize access afterwards.
			</small>
		</div>
	)
}

export const deepLinkCss = {
	display: 'grid',
	gap: '0.45rem',
	justifyItems: 'start',
}

const deepLinkButtonCss = getPillButtonCss()

const deepLinkNoteCss = {
	color: colors.textMuted,
	fontSize: '0.88rem',
}

const pluginAlternativeCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	gap: '0.35rem 0.5rem',
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.88rem',
	maxWidth: '72ch',
	'& code': {
		overflowWrap: 'anywhere' as const,
	},
}

/* Config snippets: labeled wells with their copy button in the header. */
const snippetCss = {
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.card,
	backgroundColor: colors.background,
	overflow: 'hidden' as const,
	minWidth: 0,
	width: '100%',
}

const snippetHeadCss = {
	display: 'flex',
	justifyContent: 'space-between',
	alignItems: 'center',
	gap: '0.6rem',
	padding: '0.5rem 0.6rem 0.5rem 1.1rem',
	borderBottom: `1px solid ${colors.border}`,
	'@media (max-width: 720px)': {
		flexWrap: 'wrap' as const,
	},
}

const snippetLabelCss = {
	font: `700 0.75rem/1 ${typography.fontFamilyDisplay}`,
	textTransform: 'uppercase' as const,
	letterSpacing: '0.09em',
	color: colors.textMuted,
}

/* Header copy buttons run one size down from the standalone pills. */
const snippetActionCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	justifyContent: 'flex-end',
	gap: '0.4rem',
	'& > button, & > a': {
		fontSize: '0.88rem',
		padding: '0.5rem 1rem',
	},
}

const appIconBodyCss = {
	display: 'grid',
	justifyItems: 'start',
	gap: '0.75rem',
	padding: '1rem 1.2rem',
}

const appIconImgCss = {
	display: 'block',
	width: 'min(256px, 100%)',
	height: 'auto',
	aspectRatio: '1',
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
}

const appIconHintCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.88rem',
	maxWidth: '48ch',
}

const snippetPreCss = {
	'& pre': {
		margin: 0,
		padding: '1rem 1.2rem',
		font: '500 0.92rem/1.6 ui-monospace, "SF Mono", Menlo, monospace',
		whiteSpace: 'pre-wrap' as const,
		wordBreak: 'break-word' as const,
		backgroundColor: 'transparent',
		overflow: 'visible' as const,
	},
	'& pre code': {
		font: 'inherit',
		color: 'inherit',
		backgroundColor: 'transparent',
		border: 'none',
		borderRadius: 0,
		padding: 0,
	},
}

/** Gold/amber already used for caution chrome (fork-outdated copy). */
const warningAccent = 'oklch(0.72 0.14 85)'

function getClientNoteCss(accentColor: string) {
	return {
		...getAccentCalloutCss({ accentColor }),
		margin: 0,
		padding: '0.55rem 0.85rem',
		backgroundColor: `oklch(from ${accentColor} l c h / 0.08)`,
		color: colors.textMuted,
		fontSize: typography.fontSize.sm,
		maxWidth: '72ch',
		'& a': {
			color: colors.primaryText,
		},
	}
}

const clientDangerCss = getClientNoteCss(colors.danger)
const clientCautionCss = getClientNoteCss(warningAccent)
