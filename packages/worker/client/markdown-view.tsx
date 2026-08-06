/**
 * Safe markdown rendering for untrusted, third-party authored content
 * (community package READMEs).
 *
 * Safety model (do not regress):
 * - Markdown is parsed with `marked`'s lexer only; its HTML renderer is never
 *   used. Output is built exclusively from JSX text and an allowlist of token
 *   types, so every string goes through the framework's escaping.
 * - Raw HTML tokens (block and inline) are rendered as escaped literal text,
 *   never as markup.
 * - Fenced code is highlighted with Shiki tokens rendered as JSX text and
 *   inline styles — never `innerHTML` — so highlighting cannot introduce
 *   markup. Unknown languages fall back to escaped plaintext.
 * - No resource-loading elements are emitted (`<img>`, `<iframe>`, media,
 *   etc.), so a README can never make a viewer's browser issue requests —
 *   including to hosted package endpoints (`/@username/packages/*`), which
 *   execute author-controlled code. Images render as plain links instead.
 * - Links must be absolute `http:`/`https:`/`mailto:` URLs. Relative URLs
 *   (which would resolve against this origin) and URLs whose path points at a
 *   user scope (`/@...`) render as plain text. Allowed links open in a new
 *   tab with `rel="noopener noreferrer nofollow ugc"`.
 *
 * The first-party CSP (`security-headers.ts`) blocks off-site scripts,
 * images, and connections as defense in depth; this module must stay safe
 * without relying on it.
 */
import { lexer, type Token, type Tokens } from 'marked'
import { type Handle, type RemixNode, css } from 'remix/ui'
import { CopyCodeBlock } from '#client/copy-code-block.tsx'
import { colors, radius, spacing, typography } from '#client/styles/tokens.ts'
import { renderHighlightedCode } from '#client/syntax-highlight.tsx'

const allowedLinkProtocols = new Set(['http:', 'https:', 'mailto:'])

export type RenderMarkdownOptions = {
	/**
	 * Added to each heading's authored depth before rendering (clamped to
	 * h2–h6, so page-owned h1 is never emitted). Defaults to 2 — the README
	 * demotion where `#` renders as h3. First-party surfaces that own their h1
	 * (the blog post) pass 0 so `##` keeps its authored h2 rhythm.
	 */
	headingOffset?: number
	/**
	 * `rel` for allowed links. Defaults to the third-party README policy
	 * (`nofollow ugc`); first-party content passes 'noopener noreferrer'.
	 */
	linkRel?: string
	/**
	 * Link resolution policy. The default `untrusted` policy (community
	 * READMEs) only allows absolute http(s)/mailto URLs and refuses anything
	 * that reaches a user scope. `first-party` is ONLY for repo-authored
	 * content (guides, blog): it additionally allows same-origin relative
	 * links (`/connect/oauth?...`), rendered as normal same-tab navigations.
	 * User-scope paths stay refused under every policy.
	 */
	linkPolicy?: 'untrusted' | 'first-party'
	/**
	 * Render fenced code blocks with a copy-to-clipboard button. Only for
	 * first-party surfaces whose snippets are meant to be pasted (guides).
	 */
	copyCodeBlocks?: boolean
}

type ResolvedRenderOptions = Required<RenderMarkdownOptions>

const defaultRenderOptions: ResolvedRenderOptions = {
	headingOffset: 2,
	linkRel: 'noopener noreferrer nofollow ugc',
	linkPolicy: 'untrusted',
	copyCodeBlocks: false,
}

/**
 * True when the URL's path could reach a user scope (`/@...`, where hosted
 * package apps live). Deliberately over-matches: repeated leading slashes
 * collapse (the worker routes with `split('/').filter(Boolean)`, so
 * `//@user` still reaches package apps) and percent-encoding is decoded
 * repeatedly (`/%40user`, `/%2540user`) before checking. Undecodable paths
 * are treated as user-scope so ambiguity always fails closed.
 */
function hasUserScopePath(url: URL): boolean {
	let pathname = url.pathname
	for (let pass = 0; ; pass++) {
		let decoded: string
		try {
			decoded = decodeURIComponent(pathname)
		} catch {
			return true
		}
		if (decoded === pathname) break
		// Still decodable after several passes: pathologically nested
		// encoding, so fail closed rather than guessing.
		if (pass >= 4) return true
		pathname = decoded
	}
	return pathname.replace(/^\/+/, '').startsWith('@')
}

/**
 * Returns a normalized href when the link is safe to emit, otherwise null.
 * Only absolute http(s)/mailto URLs pass, and any URL whose path enters a
 * user scope is refused on every host so READMEs cannot funnel viewers into
 * author-controlled endpoints.
 */
export function getSafeMarkdownLinkHref(href: string): string | null {
	let url: URL
	try {
		url = new URL(href)
	} catch {
		return null
	}
	if (!allowedLinkProtocols.has(url.protocol)) return null
	if (hasUserScopePath(url)) return null
	return url.href
}

type ResolvedMarkdownLink = { href: string; external: boolean }

/**
 * Resolves a link under the render options' policy. Under `first-party`,
 * root-relative links (`/guides/oauth`, `/connect/oauth?...`) resolve as
 * internal same-tab navigations — still refusing user-scope paths, which are
 * never linkable from rendered markdown regardless of trust level.
 */
function resolveMarkdownLink(
	href: string,
	options: ResolvedRenderOptions,
): ResolvedMarkdownLink | null {
	if (options.linkPolicy === 'first-party' && href.startsWith('/')) {
		let url: URL
		try {
			url = new URL(href, 'https://kody.local')
		} catch {
			return null
		}
		if (hasUserScopePath(url)) return null
		return { href: `${url.pathname}${url.search}${url.hash}`, external: false }
	}
	const safeHref = getSafeMarkdownLinkHref(href)
	if (!safeHref) return null
	return { href: safeHref, external: true }
}

/** True when raw HTML consists only of comments and whitespace. */
function isHtmlCommentOnly(raw: unknown): boolean {
	if (typeof raw !== 'string') return false
	const stripped = raw.replace(/<!--[\s\S]*?-->/g, '')
	return stripped.trim() === '' && stripped !== raw
}

const namedEntities: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: '\u00a0',
}

/**
 * Markdown text tokens keep character references (`&amp;`, `&#65;`) verbatim
 * because marked expects HTML passthrough. We render as JSX text (which
 * re-escapes), so decode them first to display what the author meant.
 */
function decodeCharacterReferences(value: string): string {
	if (!value.includes('&')) return value
	return value.replace(
		/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi,
		(match, entity: string) => {
			if (entity.startsWith('#')) {
				const codePoint =
					entity[1]?.toLowerCase() === 'x'
						? Number.parseInt(entity.slice(2), 16)
						: Number.parseInt(entity.slice(1), 10)
				if (!Number.isInteger(codePoint) || codePoint <= 0) return match
				try {
					return String.fromCodePoint(codePoint)
				} catch {
					return match
				}
			}
			return namedEntities[entity.toLowerCase()] ?? match
		},
	)
}

function renderLink(
	key: number,
	href: string,
	children: RemixNode,
	options: ResolvedRenderOptions,
): RemixNode {
	const resolved = resolveMarkdownLink(href, options)
	if (!resolved) return <span key={key}>{children}</span>
	if (!resolved.external) {
		return (
			<a key={key} href={resolved.href}>
				{children}
			</a>
		)
	}
	return (
		<a key={key} href={resolved.href} target="_blank" rel={options.linkRel}>
			{children}
		</a>
	)
}

function renderTableCell(
	cell: Tokens.TableCell,
	key: number,
	tag: 'th' | 'td',
	options: ResolvedRenderOptions,
): RemixNode {
	const Tag = tag
	return (
		<Tag
			key={key}
			mix={cell.align ? css({ textAlign: cell.align }) : undefined}
		>
			{renderTokens(cell.tokens, options)}
		</Tag>
	)
}

function renderToken(
	token: Token,
	key: number,
	options: ResolvedRenderOptions,
): RemixNode {
	switch (token.type) {
		case 'space':
		case 'def':
			return null
		case 'heading': {
			// Authored depth + offset, clamped so the page always owns h1 (the
			// README default offset of 2 also keeps listing-owned h2 clear).
			const level = Math.min(
				Math.max(token.depth + options.headingOffset, 2),
				6,
			)
			const Tag = `h${level}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
			return <Tag key={key}>{renderTokens(token.tokens, options)}</Tag>
		}
		case 'paragraph':
			return <p key={key}>{renderTokens(token.tokens, options)}</p>
		case 'blockquote':
			return (
				<blockquote key={key}>{renderTokens(token.tokens, options)}</blockquote>
			)
		case 'hr':
			return <hr key={key} />
		case 'code': {
			const codeToken = token as Tokens.Code
			if (options.copyCodeBlocks) {
				return (
					<CopyCodeBlock
						key={key}
						code={codeToken.text}
						lang={codeToken.lang}
					/>
				)
			}
			return renderHighlightedCode(codeToken.text, codeToken.lang, key)
		}
		case 'list': {
			// marked's Token union includes a generic catch-all, so `type`
			// narrowing alone leaves these fields untyped (same for `table`).
			const listToken = token as Tokens.List
			const items = listToken.items.map((item, index) =>
				renderToken(item, index, options),
			)
			if (!listToken.ordered) return <ul key={key}>{items}</ul>
			const start =
				typeof listToken.start === 'number' && listToken.start !== 1
					? listToken.start
					: undefined
			return (
				<ol key={key} start={start}>
					{items}
				</ol>
			)
		}
		case 'list_item':
			return <li key={key}>{renderTokens(token.tokens, options)}</li>
		case 'checkbox':
			return (
				<input key={key} type="checkbox" disabled checked={token.checked} />
			)
		case 'table': {
			const tableToken = token as Tokens.Table
			return (
				<table key={key}>
					<thead>
						<tr>
							{tableToken.header.map((cell, index) =>
								renderTableCell(cell, index, 'th', options),
							)}
						</tr>
					</thead>
					<tbody>
						{tableToken.rows.map((row, rowIndex) => (
							<tr key={rowIndex}>
								{row.map((cell, cellIndex) =>
									renderTableCell(cell, cellIndex, 'td', options),
								)}
							</tr>
						))}
					</tbody>
				</table>
			)
		}
		case 'strong':
			return <strong key={key}>{renderTokens(token.tokens, options)}</strong>
		case 'em':
			return <em key={key}>{renderTokens(token.tokens, options)}</em>
		case 'del':
			return <del key={key}>{renderTokens(token.tokens, options)}</del>
		case 'codespan':
			return <code key={key}>{token.text}</code>
		case 'br':
			return <br key={key} />
		case 'escape':
			return token.text
		case 'link':
			return renderLink(
				key,
				token.href,
				renderTokens(token.tokens, options),
				options,
			)
		case 'image':
			// Never emit <img>: auto-loading author-chosen URLs is exactly what
			// this renderer exists to prevent. Offer the image as a link instead.
			return renderLink(key, token.href, token.text || token.href, options)
		case 'html':
			// Comment-only tokens carry author/agent notes (guides embed agent
			// steering in HTML comments); showing them as literal text would
			// leak scaffolding into the page, so they render as nothing under
			// every policy. Other raw HTML stays escaped literal text so
			// authors see their markup but it never becomes part of the
			// document.
			if (isHtmlCommentOnly(token.raw)) return null
			return token.raw
		case 'text': {
			const textToken = token as Tokens.Text
			if (textToken.tokens?.length) {
				return <span key={key}>{renderTokens(textToken.tokens, options)}</span>
			}
			return decodeCharacterReferences(textToken.text)
		}
		default:
			// marked's token union is open (extensions add types), so exhaustive
			// `never` checking is impossible; fall back to escaped raw text.
			return typeof token.raw === 'string' ? token.raw : null
	}
}

function renderTokens(
	tokens: Array<Token> | undefined,
	options: ResolvedRenderOptions,
): Array<RemixNode> {
	if (!tokens) return []
	return tokens.map((token, index) => renderToken(token, index, options))
}

/** Parses untrusted markdown and returns safe JSX (see module docs). */
export function renderMarkdownNodes(
	markdown: string,
	options?: RenderMarkdownOptions,
): Array<RemixNode> {
	return renderTokens(lexer(markdown), { ...defaultRenderOptions, ...options })
}

export type MarkdownViewProps = { markdown: string }

export function MarkdownView(handle: Handle<MarkdownViewProps>) {
	let renderedForMarkdown: string | null = null
	let rendered: Array<RemixNode> = []

	return () => {
		if (handle.props.markdown !== renderedForMarkdown) {
			renderedForMarkdown = handle.props.markdown
			rendered = renderMarkdownNodes(handle.props.markdown)
		}
		return <div mix={css(markdownCss)}>{rendered}</div>
	}
}

const markdownCss = {
	fontSize: typography.fontSize.sm,
	lineHeight: 1.6,
	color: colors.text,
	overflowWrap: 'break-word' as const,
	'& > :first-child': {
		marginTop: 0,
	},
	'& > :last-child': {
		marginBottom: 0,
	},
	'& h3, & h4, & h5, & h6': {
		margin: `${spacing.lg} 0 ${spacing.xs}`,
		lineHeight: 1.3,
	},
	'& h3': {
		fontSize: typography.fontSize.lg,
	},
	'& h4': {
		fontSize: typography.fontSize.base,
	},
	'& p, & blockquote, & pre, & table, & ul, & ol': {
		margin: `${spacing.sm} 0`,
	},
	'& ul, & ol': {
		paddingLeft: spacing.lg,
	},
	'& li': {
		margin: `${spacing.xs} 0`,
	},
	'& blockquote': {
		borderLeft: `3px solid ${colors.border}`,
		paddingLeft: spacing.md,
		color: colors.textMuted,
	},
	'& pre': {
		padding: spacing.md,
		borderRadius: radius.md,
		border: `1px solid ${colors.border}`,
		backgroundColor: colors.background,
		overflowX: 'auto' as const,
	},
	'& code': {
		fontSize: typography.fontSize.sm,
	},
	'& table': {
		borderCollapse: 'collapse' as const,
		display: 'block',
		overflowX: 'auto' as const,
	},
	'& th, & td': {
		border: `1px solid ${colors.border}`,
		padding: `${spacing.xs} ${spacing.sm}`,
		textAlign: 'left' as const,
	},
	'& th': {
		fontWeight: typography.fontWeight.semibold,
	},
	'& a': {
		color: colors.primaryText,
		textDecoration: 'underline',
	},
	'& hr': {
		border: 'none',
		borderTop: `1px solid ${colors.border}`,
		margin: `${spacing.lg} 0`,
	},
}
