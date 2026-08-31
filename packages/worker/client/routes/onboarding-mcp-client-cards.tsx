import { type Handle, css } from 'remix/ui'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { colors, radius, typography } from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
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

type AppIconCardProps = {
	src: string
	downloadName: string
}

/**
 * ChatGPT wants a PNG you can upload, not a URL to copy. Render the icon so
 * right-click / long-press Save as works, and keep a same-origin download
 * plus a quiet URL copy for hosts that still fetch by URL.
 */
export function AppIconCard(handle: Handle<AppIconCardProps>) {
	return () => (
		<div data-testid="onboarding-mcp-app-icon" mix={css(snippetCss)}>
			<div mix={css(snippetHeadCss)}>
				<span mix={css(snippetLabelCss)}>App icon</span>
				<div mix={css(snippetActionCss)}>
					<a
						href={handle.props.src}
						download={handle.props.downloadName}
						mix={css(appIconDownloadCss)}
					>
						Download PNG
					</a>
					<CopyTextButton
						value={handle.props.src}
						idleLabel="Copy icon URL"
						variant="ghost"
					/>
				</div>
			</div>
			<div mix={css(appIconBodyCss)}>
				<img
					src={handle.props.src}
					alt="Kody app icon"
					width={144}
					height={144}
					mix={css(appIconImgCss)}
				/>
				<p mix={css(appIconHintCss)}>
					Right-click the icon and choose Save as (on a phone, long-press), then
					upload it in ChatGPT. Icons over 10 KB are rejected.
				</p>
			</div>
		</div>
	)
}

type ClientNoteProps = {
	children: string
}

/* Host-fit aside: a footnote, not a warning — the filled green well stays
   reserved for the one-time-authorization callout. */
export function ClientNote(handle: Handle<ClientNoteProps>) {
	return () => (
		<p mix={css(clientNoteCss)} role="note">
			{handle.props.children}
		</p>
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
		alternativeValue: string
		alternativeCopyLabel: string
	}>,
) {
	return () => (
		<div data-testid="onboarding-mcp-plugin-primary" mix={css(deepLinkCss)}>
			<a href={handle.props.href} mix={css(deepLinkButtonCss)}>
				{handle.props.label}
			</a>
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

const appIconDownloadCss = getGhostButtonCss()

const appIconBodyCss = {
	display: 'grid',
	justifyItems: 'start',
	gap: '0.75rem',
	padding: '1rem 1.2rem',
}

const appIconImgCss = {
	display: 'block',
	width: '144px',
	height: '144px',
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

const clientNoteCss = {
	margin: '0.3rem 0 0',
	padding: '0.15rem 0 0.15rem 1rem',
	borderLeft: `3px solid oklch(from ${colors.primary} l c h / 0.55)`,
	color: colors.textMuted,
	fontSize: '0.95rem',
	maxWidth: '62ch',
}
