import { type RemixNode, css, ref } from 'remix/ui'
import { routerEvents } from '#client/client-router.tsx'
import { type DocSummaryLoaderData } from '#universal/loader-data.ts'
import {
	docHref,
	docsCurrentPageLabel,
	docsNav,
	findDocsNavNeighbors,
	resolveDocsNavSection,
	type DocsNavSection,
} from '#universal/docs-nav.ts'
import { routes } from '#universal/routes.ts'
import { colors, mq, transitions } from '#universal/styles/tokens.ts'
import {
	hoverMq,
	layoutMaxWidths,
	mergeCss,
	pageGutter,
} from '#universal/styles/style-primitives.ts'

/**
 * Two-column docs shell: a sticky sidebar with the whole reading order
 * (`#universal/docs-nav.ts`) and the article column. Below the tablet
 * breakpoint the sidebar collapses into a native `<details>` menu above the
 * article so the page needs no JS to browse.
 *
 * `current` is the doc slug being read, or `'connect'` on the provider
 * index. Sidebar labels are the short nav labels; page titles stay in the
 * article.
 */
export function renderDocsShell(input: {
	current: string
	children: RemixNode
}) {
	const { current, children } = input
	const currentSection = resolveDocsNavSection(current)
	return (
		<div mix={css(docsLayoutCss)}>
			<aside data-docs-nav mix={css(docsSidebarCss)}>
				<nav aria-label="Docs" mix={css(docsSidebarNavCss)}>
					{renderDocsNavSections(current, currentSection)}
				</nav>
			</aside>
			<details
				mix={[
					css(docsMobileMenuCss),
					ref((node, signal) => {
						if (!(node instanceof HTMLDetailsElement)) return
						const close = () => {
							node.open = false
						}
						routerEvents.addEventListener('navigate', close, { signal })
					}),
				]}
			>
				<summary>
					<span>Docs</span>
					<span mix={css(docsMobileMenuCurrentCss)}>
						{docsCurrentPageLabel(current)}
					</span>
				</summary>
				<nav aria-label="Docs" mix={css(docsSidebarNavCss)}>
					{renderDocsNavSections(current, currentSection)}
				</nav>
			</details>
			<div mix={css(docsMainCss)}>{children}</div>
		</div>
	)
}

function renderDocsNavSections(
	current: string,
	currentSection: DocsNavSection | null,
) {
	return docsNav.map((section) => (
		<section key={section.id} mix={css(docsNavSectionCss)}>
			<h2>
				{section.id === 'providers' ? (
					<a
						href={routes.docsConnect.href()}
						aria-current={current === 'connect' ? 'page' : undefined}
					>
						{section.label}
					</a>
				) : (
					section.label
				)}
			</h2>
			<ul>
				{section.items.map((item) => (
					<li key={item.slug}>
						<a
							href={docHref(item.slug)}
							aria-current={item.slug === current ? 'page' : undefined}
							data-section-current={
								currentSection?.id === section.id ? 'true' : undefined
							}
						>
							{item.label}
						</a>
					</li>
				))}
			</ul>
		</section>
	))
}

/** Previous / next links in reading order for the foot of an article. */
export function renderDocsPager(slug: string) {
	const { prev, next } = findDocsNavNeighbors(slug)
	if (!prev && !next) return null
	return (
		<nav aria-label="Docs order" mix={css(docsPagerCss)}>
			{prev ? (
				<a href={docHref(prev.slug)} mix={css(docsPagerLinkCss)}>
					<span>Previous</span>
					<strong>{prev.label}</strong>
				</a>
			) : null}
			{next ? (
				<a href={docHref(next.slug)} mix={css(docsPagerNextLinkCss)}>
					<span>Next</span>
					<strong>{next.label}</strong>
				</a>
			) : null}
		</nav>
	)
}

export function formatLastVerified(lastVerified: string): string {
	const [year, month] = lastVerified.split('-')
	const monthIndex = Number(month) - 1
	const monthNames = [
		'January',
		'February',
		'March',
		'April',
		'May',
		'June',
		'July',
		'August',
		'September',
		'October',
		'November',
		'December',
	]
	const name = monthNames[monthIndex]
	if (!name || !year) return lastVerified
	return `${name} ${year}`
}

export function renderDocListItem(doc: DocSummaryLoaderData, index: number) {
	return (
		<li key={doc.slug} data-rise style={{ '--rise': String(index + 2) }}>
			<a href={docHref(doc.slug)} mix={css(docListLinkCss)}>
				<strong>{doc.title}</strong>
				{doc.lastVerified ? (
					<span mix={css(docListMetaCss)}>
						Verified {formatLastVerified(doc.lastVerified)}
					</span>
				) : null}
				<span mix={css(docListSummaryCss)}>{doc.summary}</span>
			</a>
		</li>
	)
}

const sidebarWidth = '15.5rem'

const docsLayoutCss = {
	display: 'grid',
	gridTemplateColumns: `${sidebarWidth} minmax(0, 1fr)`,
	columnGap: 'clamp(2rem, 4vw, 3.5rem)',
	alignItems: 'start',
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	paddingInline: pageGutter,
	[mq.tablet]: {
		display: 'block',
	},
}

const docsSidebarCss = {
	position: 'sticky' as const,
	// The sticky site header is ~4rem tall; keep the sidebar just under it.
	top: '4.5rem',
	maxHeight: 'calc(100vh - 5.5rem)',
	overflowY: 'auto' as const,
	paddingBlock: 'clamp(2.5rem, 6vw, 4rem) 2rem',
	paddingRight: '0.5rem',
	borderRight: `1px solid ${colors.border}`,
	scrollbarWidth: 'thin' as const,
	[mq.tablet]: {
		display: 'none',
	},
}

const docsSidebarNavCss = {
	display: 'grid',
	gap: '1.35rem',
	fontSize: '0.92rem',
}

const docsNavSectionCss = {
	'& h2': {
		margin: '0 0 0.4rem',
		fontSize: '0.74rem',
		fontWeight: 700,
		letterSpacing: '0.08em',
		textTransform: 'uppercase' as const,
		color: colors.textMuted,
	},
	'& h2 a': {
		color: 'inherit',
		textDecoration: 'none',
	},
	'& h2 a[aria-current="page"]': {
		color: colors.primaryText,
	},
	'&:has(a[data-section-current]) h2': {
		color: colors.text,
	},
	'& ul': {
		listStyle: 'none',
		margin: 0,
		padding: 0,
		display: 'grid',
		gap: '0.1rem',
	},
	'& li a': {
		display: 'block',
		padding: '0.32rem 0.6rem',
		marginLeft: '-0.6rem',
		borderRadius: '0.45rem',
		color: colors.textMuted,
		textDecoration: 'none',
		lineHeight: 1.35,
		transition: `color ${transitions.fast}, background ${transitions.fast}`,
	},
	'& li a[aria-current="page"]': {
		color: colors.primaryText,
		fontWeight: 650,
		background: colors.primarySoftest,
	},
	[hoverMq]: {
		'& li a:hover': {
			color: colors.text,
			background: colors.primarySoftest,
		},
	},
}

const docsMobileMenuCss = {
	display: 'none',
	margin: 'clamp(1.5rem, 4vw, 2rem) 0 0',
	border: `1px solid ${colors.border}`,
	borderRadius: '0.75rem',
	background: colors.surface,
	'& > summary': {
		display: 'flex',
		alignItems: 'baseline',
		gap: '0.6rem',
		padding: '0.8rem 1rem',
		cursor: 'pointer',
		fontWeight: 650,
		color: colors.text,
		listStyle: 'none',
	},
	'& > summary::-webkit-details-marker': { display: 'none' },
	'& > summary::marker': { content: '""' },
	'& > summary::before': {
		content: '"☰"',
		color: colors.textMuted,
		fontSize: '0.95rem',
	},
	'& > nav': {
		padding: '0.4rem 1rem 1rem 1.6rem',
		borderTop: `1px solid ${colors.border}`,
	},
	[mq.tablet]: {
		display: 'block',
	},
}

const docsMobileMenuCurrentCss = {
	color: colors.textMuted,
	fontWeight: 500,
	fontSize: '0.9rem',
}

const docsMainCss = {
	minWidth: 0,
}

const docsPagerCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	justifyContent: 'space-between',
	gap: '1rem',
	marginTop: 'clamp(2.5rem, 6vw, 3.5rem)',
	[mq.mobile]: {
		flexDirection: 'column' as const,
	},
}

const docsPagerLinkCss = {
	display: 'grid',
	gap: '0.25rem',
	padding: '0.9rem 1.1rem',
	border: `1px solid ${colors.border}`,
	borderRadius: '0.75rem',
	textDecoration: 'none',
	color: colors.text,
	transition: `border-color ${transitions.fast}`,
	'& span': {
		fontSize: '0.78rem',
		letterSpacing: '0.06em',
		textTransform: 'uppercase' as const,
		color: colors.textMuted,
	},
	'& strong': {
		fontWeight: 650,
		color: colors.primaryText,
	},
	[hoverMq]: {
		'&:hover': { borderColor: colors.primary },
	},
}

const docsPagerNextLinkCss = mergeCss(docsPagerLinkCss, {
	marginInlineStart: 'auto',
	textAlign: 'right' as const,
	[mq.mobile]: {
		marginInlineStart: 0,
		textAlign: 'left' as const,
	},
})

export const docListCss = {
	listStyle: 'none',
	margin: '0.6rem 0 0',
	padding: 0,
	'& li + li': {
		borderTop: `1px solid ${colors.border}`,
	},
}

const docListLinkCss = {
	display: 'block',
	padding: '1.05rem 0',
	textDecoration: 'none',
	color: 'inherit',
	'& strong': {
		fontSize: '1.08rem',
		fontWeight: 700,
		letterSpacing: '-0.012em',
		transition: `color ${transitions.fast}`,
	},
	[hoverMq]: {
		'&:hover strong': {
			color: colors.primaryText,
		},
	},
}

const docListMetaCss = {
	marginLeft: '0.6rem',
	color: colors.textMuted,
	fontSize: '0.82rem',
}

const docListSummaryCss = {
	display: 'block',
	marginTop: '0.35rem',
	color: colors.textMuted,
	fontSize: '0.95rem',
	lineHeight: 1.5,
	maxWidth: '62ch',
}

export const docsGroupHeadingCss = {
	margin: 'clamp(2.4rem, 5vw, 3.2rem) 0 0',
	fontSize: '1.05rem',
	fontWeight: 720,
	letterSpacing: '0.04em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
}

export const docsListStatusCss = {
	margin: 'clamp(1.8rem, 4vw, 2.5rem) 0 0',
	color: colors.textMuted,
	fontSize: '0.98rem',
}
