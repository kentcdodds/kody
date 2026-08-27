import { type RemixNode, css } from 'remix/ui'
import { CopyCodeBlock } from '#client/copy-code-block.tsx'
import {
	type HighlightedCode,
	highlightSnippetKey,
} from '#universal/highlighted-code.ts'
import {
	walkthroughHostForAct,
	walkthroughHostMarkUrl,
	type WalkthroughHost,
	type WalkthroughHostPick,
} from '#universal/walkthrough-hosts.ts'
import {
	type TranscriptAct,
	type TranscriptFile,
	type TranscriptInput,
	type TranscriptLine,
	type TranscriptTool,
	transcriptFileLang,
} from './interactive-guide-transcript.ts'
import {
	getAccentCalloutCss,
	getArticleBreakoutCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

/**
 * Shared interactive-guide transcript renderer (How Kody works, Google OAuth,
 * and later siblings). Tool calls are native <details> so they work without
 * JavaScript. This is a render helper, not a Remix component — only
 * CopyCodeBlock needs a handle.
 */
export function renderInteractiveGuideWalkthrough(input: {
	lead: RemixNode
	acts: Array<TranscriptAct>
	afterActs?: RemixNode
	highlights?: Record<string, HighlightedCode>
	hosts?: WalkthroughHostPick
}) {
	return (
		<div mix={css(walkthroughCss)}>
			<p mix={css(leadCss)}>{input.lead}</p>

			{input.acts.map((act) => (
				<section
					key={act.id}
					mix={css(actCss)}
					aria-labelledby={`${act.id}-title`}
				>
					{act.kicker ? (
						<p
							mix={css(
								act.id === input.acts[0]?.id ? exampleKickerCss : kickerCss,
							)}
						>
							{act.kicker}
						</p>
					) : null}
					<h2 id={`${act.id}-title`}>{act.title}</h2>
					<ol mix={css(threadCss)}>
						{act.lines.map((line, index) => (
							<li key={`${act.id}-${index}`}>
								{renderInteractiveGuideLine(
									line,
									input.highlights,
									walkthroughHostForAct(input.hosts, act.id),
								)}
							</li>
						))}
					</ol>
				</section>
			))}

			{input.afterActs}
		</div>
	)
}

export function renderInteractiveGuideLine(
	line: TranscriptLine,
	highlights?: Record<string, HighlightedCode>,
	host?: WalkthroughHost,
) {
	switch (line.role) {
		case 'user':
			return (
				<figure class="landing-loop-you" mix={css(youCss)}>
					<figcaption>
						You
						{renderUserIcon()}
					</figcaption>
					<blockquote>
						<p>{line.text}</p>
					</blockquote>
				</figure>
			)
		case 'agent': {
			const reasoning = line.tone === 'reasoning'
			return (
				<figure mix={css(reasoning ? agentReasoningCss : agentCss)}>
					<figcaption>
						{host ? renderAgentMark(host) : renderAgentIcon()}
						{host?.label ?? 'Agent'}
					</figcaption>
					<blockquote>
						<p>{reasoning ? `Reasoning: ${line.text}` : line.text}</p>
					</blockquote>
				</figure>
			)
		}
		case 'tools':
			return (
				<div mix={css(toolsCss)}>
					{line.tools.map((tool) => renderToolCall(tool, highlights))}
				</div>
			)
		case 'files':
			return renderFiles(line, highlights)
		default: {
			const exhaustive: never = line
			return exhaustive
		}
	}
}

const leadingInputNames = ['conversationId', 'memoryContext'] as const

function sortToolInputs(inputs: Array<TranscriptInput>) {
	return [...inputs].sort((left, right) => {
		if (left.name === 'code' || right.name === 'code') {
			if (left.name === 'code' && right.name !== 'code') return 1
			if (right.name === 'code' && left.name !== 'code') return -1
		}
		const leftLead = leadingInputNames.indexOf(
			left.name as (typeof leadingInputNames)[number],
		)
		const rightLead = leadingInputNames.indexOf(
			right.name as (typeof leadingInputNames)[number],
		)
		const leftRank = leftLead === -1 ? leadingInputNames.length : leftLead
		const rightRank = rightLead === -1 ? leadingInputNames.length : rightLead
		return leftRank - rightRank
	})
}

function renderWalkthroughCode(
	highlights: Record<string, HighlightedCode> | undefined,
	code: string,
	lang: string,
) {
	return (
		<CopyCodeBlock
			copy={false}
			code={code}
			lang={lang}
			highlighted={highlights?.[highlightSnippetKey({ code, lang })]}
		/>
	)
}

function renderFiles(
	line: Extract<TranscriptLine, { role: 'files' }>,
	highlights?: Record<string, HighlightedCode>,
) {
	return (
		<div mix={css(toolsCss)}>
			<details mix={css(toolCss)}>
				<summary>
					<span mix={css(toolNameCss)}>files</span>
					<span mix={css(toolSummaryCss)}>{line.summary}</span>
				</summary>
				<div mix={css(toolBodyCss)}>
					<aside mix={css(toolNoteCss)} role="note">
						{renderInfoIcon()}
						<p>{renderNotedText(line.note)}</p>
					</aside>
					{line.files.map((file) => renderCloneFile(file, highlights))}
				</div>
			</details>
		</div>
	)
}

function renderCloneFile(
	file: TranscriptFile,
	highlights?: Record<string, HighlightedCode>,
) {
	const lang = transcriptFileLang(file.path, file.lang)
	return (
		<details key={file.path} mix={css(toolCss)}>
			<summary>
				<span mix={css(toolNameCss)}>{file.path}</span>
				<span mix={css(toolSummaryCss)}>{file.summary}</span>
			</summary>
			<div mix={css(toolBodyCss)}>
				{renderWalkthroughCode(highlights, file.content, lang)}
			</div>
		</details>
	)
}

function renderToolCall(
	tool: TranscriptTool,
	highlights?: Record<string, HighlightedCode>,
) {
	return (
		<details key={`${tool.name}-${tool.summary}`} mix={css(toolCss)}>
			<summary>
				<span mix={css(toolNameCss)}>
					{isKodyToolName(tool.name) ? renderKodyMark() : null}
					{tool.name}
				</span>
				<span mix={css(toolSummaryCss)}>{tool.summary}</span>
			</summary>
			<div mix={css(toolBodyCss)}>
				<aside mix={css(toolNoteCss)} role="note">
					{renderInfoIcon()}
					<p>{renderNotedText(tool.note)}</p>
				</aside>
				{sortToolInputs(tool.inputs).map((input) =>
					renderInput(input, highlights),
				)}
				<hr mix={css(ioRuleCss)} />
				<div mix={css(paneCss)}>
					<span mix={css(paneLabelCss)}>Returns</span>
					{renderWalkthroughCode(
						highlights,
						tool.result,
						tool.resultLang ?? 'json',
					)}
				</div>
			</div>
		</details>
	)
}

function isKodyToolName(name: string) {
	return name === 'search' || name === 'execute'
}

function renderUserIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="1em"
			height="1em"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<circle cx="12" cy="8" r="3.5" />
			<path d="M5 19.5c.7-3.2 3.4-5 7-5s6.3 1.8 7 5" />
		</svg>
	)
}

function renderAgentMark(host: WalkthroughHost) {
	return (
		<span
			mix={css(agentMarkCss)}
			style={{ '--chip-icon': `url("${walkthroughHostMarkUrl(host)}")` }}
			aria-hidden="true"
		></span>
	)
}

function renderAgentIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="1em"
			height="1em"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<rect x="5" y="8" width="14" height="11" rx="2.5" />
			<path d="M12 8V5" />
			<circle cx="12" cy="4.5" r="1" fill="currentColor" />
			<circle cx="9" cy="13.5" r="1" fill="currentColor" />
			<circle cx="15" cy="13.5" r="1" fill="currentColor" />
		</svg>
	)
}

function renderNotedText(note: string) {
	return note.split(/(`[^`]+`)/).map((part, index) => {
		if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
			return <code key={index}>{part.slice(1, -1)}</code>
		}
		return part
	})
}

function renderInfoIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="1em"
			height="1em"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 11v5" />
			<circle cx="12" cy="8" r="0.75" fill="currentColor" />
		</svg>
	)
}

function renderKodyMark() {
	return (
		<img
			src="/images/kody-mark.png"
			alt=""
			width={12}
			height={12}
			mix={css(inlineMarkCss)}
		/>
	)
}

function renderInput(
	input: TranscriptInput,
	highlights?: Record<string, HighlightedCode>,
) {
	const lang = input.lang ?? 'json'
	return (
		<div mix={css(paneCss)} data-kind={input.kind}>
			<span mix={css(paneLabelCss)}>{input.name}</span>
			{renderWalkthroughCode(highlights, input.value, lang)}
		</div>
	)
}

const walkthroughCss = {
	marginTop: 'clamp(1.8rem, 4vw, 2.5rem)',
	minWidth: 0,
	maxWidth: '100%',
}

const leadCss = {
	margin: '0 0 clamp(2rem, 5vw, 2.8rem)',
	color: colors.textMuted,
	fontSize: '1.05rem',
	textWrap: 'pretty' as const,
}

export const interactiveGuideActCss = {
	...getArticleBreakoutCss(),
	marginTop: 'clamp(2.4rem, 6vw, 3.4rem)',
	minWidth: 0,
	'& h2': {
		margin: '0.2rem 0 0',
		fontSize: '1.55rem',
		fontWeight: 720,
		letterSpacing: '-0.02em',
	},
}

const actCss = interactiveGuideActCss

export const interactiveGuideKickerCss = {
	margin: 0,
	fontSize: '0.78rem',
	fontWeight: 600,
	letterSpacing: '0.12em',
	textTransform: 'uppercase' as const,
	color: colors.primaryText,
}

const kickerCss = interactiveGuideKickerCss

const exampleKickerCss = {
	margin: 0,
	fontSize: '0.95rem',
	fontWeight: 600,
	color: colors.primaryText,
	textWrap: 'pretty' as const,
}

const threadCss = {
	listStyle: 'none',
	margin: '1.25rem 0 0',
	padding: 0,
	display: 'grid',
	gap: '0.9rem',
	minWidth: 0,
	'& > *': { minWidth: 0 },
}

const captionIconGap = '0.35em'

const agentMarkCss = {
	width: '1em',
	height: '1em',
	flex: 'none',
	background: 'currentColor',
	maskImage: 'var(--chip-icon)',
	maskPosition: 'center',
	maskSize: 'contain',
	maskRepeat: 'no-repeat',
	WebkitMaskImage: 'var(--chip-icon)',
	WebkitMaskPosition: 'center',
	WebkitMaskSize: 'contain',
	WebkitMaskRepeat: 'no-repeat',
}

const bubbleCss = {
	margin: 0,
	'& figcaption': {
		display: 'flex',
		alignItems: 'center',
		gap: captionIconGap,
		margin: 0,
		fontSize: '0.75rem',
		fontWeight: 650,
		letterSpacing: '0.06em',
		textTransform: 'uppercase' as const,
		color: colors.textMuted,
	},
	'& blockquote': {
		margin: '0.35rem 0 0',
		padding: `${spacing.sm} ${spacing.md}`,
		borderRadius: radius.lg,
		border: `1px solid ${colors.border}`,
	},
	'& p': {
		margin: 0,
		textWrap: 'pretty' as const,
	},
}

const youCss = {
	...bubbleCss,
	'& figcaption': {
		...bubbleCss['& figcaption'],
		justifyContent: 'flex-end',
		textAlign: 'right' as const,
	},
	'& blockquote': {
		...bubbleCss['& blockquote'],
		marginInlineStart: 'auto',
		maxWidth: 'min(36rem, 100%)',
		backgroundColor: colors.primarySoftest,
		borderColor: colors.primarySoft,
	},
}

const agentCss = {
	...bubbleCss,
	'& blockquote': {
		...bubbleCss['& blockquote'],
		backgroundColor: colors.surface,
	},
}

const agentReasoningCss = {
	...bubbleCss,
	'& blockquote': {
		margin: '0.25rem 0 0',
		padding: 0,
		border: 'none',
		backgroundColor: 'transparent',
	},
	'& p': {
		margin: 0,
		fontSize: '0.92rem',
		fontStyle: 'italic' as const,
		color: colors.textMuted,
		textWrap: 'pretty' as const,
	},
}

export const interactiveGuideToolsCss = {
	display: 'grid',
	gap: '0.55rem',
	minWidth: 0,
}

const toolsCss = interactiveGuideToolsCss

export const interactiveGuideToolCss = {
	minWidth: 0,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.lg,
	backgroundColor: colors.surface,
	'& summary': {
		display: 'grid',
		gridTemplateColumns: 'auto auto 1fr',
		columnGap: spacing.sm,
		rowGap: '0.15rem',
		alignItems: 'center',
		padding: `${spacing.sm} ${spacing.md}`,
		cursor: 'pointer',
		listStyle: 'none',
		'&::-webkit-details-marker': { display: 'none' },
		'&::before': {
			content: '""',
			width: '0.38em',
			height: '0.38em',
			marginInlineEnd: `calc(${spacing.sm} * 0.5)`,
			borderRight: `2px solid ${colors.textMuted}`,
			borderBottom: `2px solid ${colors.textMuted}`,
			transform: 'rotate(-45deg)',
			transition: 'transform 140ms ease',
		},
	},
	'&[open] summary': {
		borderBottom: `1px solid ${colors.border}`,
		'&::before': {
			transform: 'rotate(45deg)',
		},
	},
}

const toolCss = interactiveGuideToolCss

export const interactiveGuideToolNameCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: captionIconGap,
	fontFamily: typography.fontFamily,
	fontSize: '0.82rem',
	fontWeight: 700,
	color: colors.primaryText,
}

const toolNameCss = interactiveGuideToolNameCss

const inlineMarkCss = {
	width: '1em',
	height: '1em',
	display: 'block',
}

export const interactiveGuideToolSummaryCss = {
	fontSize: '0.92rem',
	color: colors.textMuted,
}

const toolSummaryCss = interactiveGuideToolSummaryCss

const toolNoteCss = {
	...getAccentCalloutCss(),
	gridTemplateColumns: 'auto 1fr',
	alignItems: 'start',
	columnGap: '0.65rem',
	padding: `${spacing.sm} ${spacing.md}`,
	color: colors.text,
	'& svg': {
		width: '1.15em',
		height: '1.15em',
		marginTop: '0.15em',
		color: colors.primaryText,
	},
	'& p': {
		margin: 0,
		fontSize: '0.95rem',
		textWrap: 'pretty' as const,
	},
	'& code': {
		font: '500 0.9em/1.2 ui-monospace, "SF Mono", Menlo, monospace',
		backgroundColor: colors.primarySoftest,
		border: `1px solid ${colors.primarySoft}`,
		borderRadius: '5px',
		padding: '0.1em 0.35em',
	},
}

export const interactiveGuideToolBodyCss = {
	padding: spacing.md,
	display: 'grid',
	gap: spacing.sm,
	minWidth: 0,
	'& > *': { minWidth: 0 },
}

const toolBodyCss = interactiveGuideToolBodyCss

const ioRuleCss = {
	margin: `${spacing.xs} 0`,
	border: 'none',
	borderTop: `1px solid ${colors.border}`,
}

const paneCss = {
	display: 'grid',
	gap: spacing.xs,
	minWidth: 0,
	'&[data-kind="memory"] > span': {
		backgroundColor: colors.primarySoft,
		color: colors.primaryText,
	},
}

const paneLabelCss = {
	padding: '0.1rem 0.45rem',
	justifySelf: 'start' as const,
	borderRadius: radius.full,
	backgroundColor: colors.primarySoftest,
	color: colors.textMuted,
	fontSize: '0.72rem',
	fontWeight: 700,
	letterSpacing: '0.04em',
	textTransform: 'uppercase' as const,
}

export const interactiveGuideMutedLeadCss = {
	margin: '0.7rem 0 1rem',
	color: colors.textMuted,
	textWrap: 'pretty' as const,
	'& code': {
		fontSize: '0.9em',
	},
}
