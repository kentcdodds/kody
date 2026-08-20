// remix-skill: Handle-based files explorer (tree + blob). Must be a Handle
// component so Remix can mount it from the shared /files route.
import { type Handle, type RemixNode, css } from 'remix/ui'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { on } from '#client/event-mixin.ts'
import { matchesSearchQuery } from '#client/search-filter.ts'
import { renderMarkdownNodes } from '#client/markdown-view.tsx'
import { renderHighlightedCode } from '#client/syntax-highlight.tsx'
import {
	buildPackageFilesAncestors,
	joinPackageFilesPath,
	listPackageFilesChildren,
	packageFileLanguageLabel,
} from '#universal/package-files.ts'
import { type PackageFilesLoaderData } from '#universal/loader-data.ts'
import {
	colors,
	mq,
	radius,
	spacing,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import {
	layoutMaxWidths,
	pageGutter,
	proseCss,
} from '#universal/styles/style-primitives.ts'

/** Directories on the way to `path`, which open so the file is in view. */
function ancestorDirectories(path: string) {
	return buildPackageFilesAncestors(path)
		.map((ancestor) => ancestor.path)
		.filter((candidate) => candidate !== path)
}

function formatBytes(value: string) {
	const bytes = new TextEncoder().encode(value).length
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function countLines(value: string) {
	return value.replace(/\n$/, '').split('\n').length
}

export function PackageFilesExplorer(
	handle: Handle<{ data: PackageFilesLoaderData; busy?: boolean }>,
) {
	// Directory open/closed state is the visitor's, so it survives navigation
	// between files; each newly selected path opens its own ancestors on top of
	// whatever they already opened.
	const expanded = new Set<string>()
	let openedFor: string | null = null
	let query = ''

	// Opening a directory opens it in the tree too, the way GitHub's sidebar
	// does — the row navigates *and* unfolds, rather than only doing one.
	function syncExpanded(selectedPath: string, selectionIsDirectory: boolean) {
		if (openedFor === selectedPath) return
		openedFor = selectedPath
		query = ''
		for (const directory of ancestorDirectories(selectedPath)) {
			expanded.add(directory)
		}
		if (selectionIsDirectory && selectedPath) expanded.add(selectedPath)
	}

	function toggleDirectory(path: string) {
		if (expanded.has(path)) expanded.delete(path)
		else expanded.add(path)
		handle.update()
	}

	function collapseAll() {
		expanded.clear()
		handle.update()
	}

	function setQuery(value: string) {
		if (value === query) return
		query = value
		handle.update()
	}

	// Filter keystrokes and chevron toggles re-run this whole closure; the
	// blob is untouched by either, and re-highlighting a large file with
	// Shiki on every keystroke janks the input. Selection is the only thing
	// that changes the blob.
	let contentNode: RemixNode = null
	let contentFor: string | null = null

	return () => {
		const { data } = handle.props
		syncExpanded(data.selectedPath, data.kind === 'directory')
		const contentKey = `${data.selectedPath}\n${data.contentPath ?? ''}`
		if (contentFor !== contentKey) {
			contentFor = contentKey
			contentNode = renderContent(data)
		}

		return (
			<article
				mix={css(articleCss)}
				data-testid="package-files"
				// The previous file stays on screen while the next one loads, so
				// assistive tech is told the region is mid-update.
				aria-busy={handle.props.busy ? 'true' : undefined}
			>
				<a href={data.backHref} mix={css(backLinkCss)}>
					{arrowLeftIcon()} {data.backLabel}
				</a>
				<header mix={css(headCss)}>
					<h1 mix={css(titleCss)}>{data.title}</h1>
				</header>
				<div mix={css(layoutCss)}>
					<nav aria-label="Files" mix={css(treeCss)}>
						<div mix={css(treeHeadCss)}>
							<h2 mix={css(treeHeadingCss)}>Files</h2>
							{/* Always rendered so the row keeps its height — appearing and
							    disappearing shifted the filter and tree below it. */}
							<button
								type="button"
								disabled={expanded.size === 0}
								mix={[
									css(
										expanded.size > 0
											? collapseButtonCss
											: collapseButtonHiddenCss,
									),
									on('click', collapseAll),
								]}
							>
								Collapse all
							</button>
						</div>
						<div mix={css(filterWrapCss)}>
							<div mix={css(filterFieldCss)}>
								<span mix={css(filterIconCss)}>{searchIcon()}</span>
								<input
									type="search"
									value={query}
									placeholder="Go to file"
									aria-label="Filter files"
									mix={[
										css(filterInputCss),
										on('input', (event) => {
											const target = event.target
											if (target instanceof HTMLInputElement) {
												setQuery(target.value)
											}
										}),
									]}
								/>
							</div>
						</div>
						<div mix={css(treeScrollCss)}>
							{query.trim()
								? renderMatches(data, query)
								: renderTree(
										data.paths,
										'',
										data.selectedPath,
										data.filesBasePath,
										expanded,
										toggleDirectory,
										0,
									)}
						</div>
					</nav>
					<section mix={css(contentCss)} aria-label="Selected file">
						{contentNode}
					</section>
				</div>
			</article>
		)
	}
}

const maxFilterMatches = 100

function renderMatches(data: PackageFilesLoaderData, query: string): RemixNode {
	const matches = data.paths.filter((path) => matchesSearchQuery(query, [path]))
	if (matches.length === 0) {
		return <p mix={css(emptyCss)}>No file matches that filter.</p>
	}
	const overflow = matches.length - maxFilterMatches
	return (
		<ul mix={css(treeListCss)}>
			{matches.slice(0, maxFilterMatches).map((path) => {
				const slash = path.lastIndexOf('/')
				const name = slash === -1 ? path : path.slice(slash + 1)
				const directory = slash === -1 ? '' : path.slice(0, slash)
				return (
					<li key={path}>
						<a
							href={joinPackageFilesPath(data.filesBasePath, path)}
							aria-current={data.selectedPath === path ? 'page' : undefined}
							mix={css(data.selectedPath === path ? rowCurrentCss : rowCss)}
						>
							<span mix={css(rowIconCss)}>{fileIcon()}</span>
							<span mix={css(rowNameCss)}>{name}</span>
							{directory ? (
								<span mix={css(rowMetaCss)}>{directory}</span>
							) : null}
						</a>
					</li>
				)
			})}
			{overflow > 0 ? (
				<li>
					<p mix={css(emptyCss)}>
						…and {overflow} more. Keep typing to narrow.
					</p>
				</li>
			) : null}
		</ul>
	)
}

function renderTree(
	paths: Array<string>,
	directoryPath: string,
	selectedPath: string,
	filesBasePath: string,
	expanded: Set<string>,
	toggleDirectory: (path: string) => void,
	depth: number,
): RemixNode {
	const children = listPackageFilesChildren(paths, directoryPath)
	if (children.length === 0 && directoryPath === '') {
		return <p mix={css(emptyCss)}>No published files.</p>
	}
	return (
		<ul mix={css(treeListCss)}>
			{children.map((child) => {
				const href = joinPackageFilesPath(filesBasePath, child.path)
				const current = selectedPath === child.path
				const isDirectory = child.kind === 'directory'
				const isOpen = isDirectory && expanded.has(child.path)
				return (
					<li key={child.path}>
						<div mix={css(rowShellCss)} style={`padding-left: ${depth * 14}px`}>
							{isDirectory ? (
								<button
									type="button"
									aria-expanded={isOpen ? 'true' : 'false'}
									aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${child.name}`}
									mix={[
										css(chevronButtonCss),
										on('click', () => toggleDirectory(child.path)),
									]}
								>
									<span mix={css(isOpen ? chevronOpenCss : chevronCss)}>
										{chevronIcon()}
									</span>
								</button>
							) : (
								<span mix={css(chevronSpacerCss)} aria-hidden="true" />
							)}
							<a
								href={href}
								aria-current={current ? 'page' : undefined}
								mix={css(current ? rowCurrentCss : rowCss)}
							>
								<span mix={css(isDirectory ? rowDirIconCss : rowIconCss)}>
									{isDirectory ? directoryIcon() : fileIcon()}
								</span>
								<span mix={css(rowNameCss)}>{child.name}</span>
							</a>
						</div>
						{isOpen
							? renderTree(
									paths,
									child.path,
									selectedPath,
									filesBasePath,
									expanded,
									toggleDirectory,
									depth + 1,
								)
							: null}
					</li>
				)
			})}
		</ul>
	)
}

function renderContent(data: PackageFilesLoaderData): RemixNode {
	if (data.kind === 'directory' && !data.content) {
		return (
			<div>
				<div mix={css(contentToolbarCss)}>
					<div mix={css(contentHeadingWrapCss)}>
						<span mix={css(headingIconCss)}>{directoryIcon()}</span>
						<h2 mix={css(contentHeadingCss)}>
							{data.selectedPath ? data.selectedPath : 'Package root'}
						</h2>
					</div>
				</div>
				{data.children.length === 0 ? (
					<p mix={css(emptyCss)}>This folder is empty.</p>
				) : (
					<ul mix={css(dirListCss)}>
						{data.children.map((child) => (
							<li key={child.path}>
								<a
									href={joinPackageFilesPath(data.filesBasePath, child.path)}
									mix={css(dirLinkCss)}
								>
									<span
										mix={css(
											child.kind === 'directory' ? rowDirIconCss : rowIconCss,
										)}
									>
										{child.kind === 'directory' ? directoryIcon() : fileIcon()}
									</span>
									<span mix={css(rowNameCss)}>{child.name}</span>
								</a>
							</li>
						))}
					</ul>
				)}
			</div>
		)
	}

	const heading = data.contentPath ?? data.selectedPath
	const body = data.content ?? ''
	return (
		<div>
			<div mix={css(contentToolbarCss)}>
				<div mix={css(contentHeadingWrapCss)}>
					<span mix={css(headingIconCss)}>{fileIcon()}</span>
					<h2 mix={css(contentHeadingCss)} title={heading}>
						{heading}
					</h2>
					{body ? (
						<span mix={css(contentMetaCss)}>
							{countLines(body)} lines · {formatBytes(body)}
							{packageFileLanguageLabel(data.contentPath)
								? ` · ${packageFileLanguageLabel(data.contentPath)}`
								: ''}
						</span>
					) : null}
				</div>
				{body ? (
					<CopyTextButton
						value={body}
						idleLabel="Copy"
						variant="ghost"
						size="sm"
						ariaLabel={`Copy ${heading}`}
					/>
				) : null}
			</div>
			{data.contentKind === 'markdown' ? (
				<div mix={css(markdownCss)} data-testid="package-files-markdown">
					{renderMarkdownNodes(body)}
				</div>
			) : (
				<div mix={css(codeCss)} data-testid="package-files-code">
					{renderHighlightedCode(body, data.language ?? 'plaintext')}
				</div>
			)}
		</div>
	)
}

/* ---------- icons ---------- */

function arrowLeftIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="14"
			height="14"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M19 12H5" />
			<path d="m12 19-7-7 7-7" />
		</svg>
	)
}

function chevronIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="12"
			height="12"
			fill="none"
			stroke="currentColor"
			stroke-width="2.5"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="m9 18 6-6-6-6" />
		</svg>
	)
}

function directoryIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="15"
			height="15"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M4 20V6a1 1 0 0 1 1-1h4.6a1 1 0 0 1 .8.4l1.2 1.6H19a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z" />
		</svg>
	)
}

function fileIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="15"
			height="15"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M14 3v5h5" />
			<path d="M15 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6Z" />
		</svg>
	)
}

function searchIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="14"
			height="14"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<circle cx="11" cy="11" r="7" />
			<path d="m21 21-4.3-4.3" />
		</svg>
	)
}

/* ---------- styles ---------- */

// Same box as the site header (`navCss`): `layoutMaxWidths.extended` centered,
// inset by `pageGutter`. A container that picks its own padding renders wider
// than the nav above it.
// This route owns its gutters — the shell leaves it unpadded (`app.tsx`), so
// the same box as the site header lines the two up at every width.
const articleCss = {
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	padding: `${spacing.lg} ${pageGutter} ${spacing['2xl']}`,
	[mq.tablet]: {
		padding: `${spacing.md} ${pageGutter} ${spacing.xl}`,
	},
}

const backLinkCss = {
	// Pinned out of the `page` transition with the rest of the explorer chrome.
	viewTransitionName: 'files-back',
	display: 'inline-flex',
	alignItems: 'center',
	gap: spacing.xs,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.medium,
	color: colors.primaryText,
	textDecoration: 'none',
	'&:hover': { color: colors.text },
}

const headCss = {
	// Lifted out of the `page` view transition (see `public/styles.css`) so the
	// title does not slide on every in-explorer file switch.
	viewTransitionName: 'files-head',
	// The back link reads as part of this head, so it sits tight to the title.
	marginTop: spacing.sm,
	marginBottom: spacing.lg,
	display: 'grid',
	gap: spacing.xs,
}

const titleCss = {
	margin: 0,
	fontSize: typography.fontSize['2xl'],
	fontWeight: typography.fontWeight.semibold,
	overflowWrap: 'anywhere' as const,
}

// Two columns need room for both: below the tablet breakpoint the blob is too
// narrow to read code in, so the tree moves above it and runs full width.
const layoutCss = {
	display: 'grid',
	gridTemplateColumns: '18.75rem minmax(0, 1fr)',
	gap: spacing.lg,
	alignItems: 'start',
	[mq.tablet]: {
		gridTemplateColumns: 'minmax(0, 1fr)',
		gap: spacing.md,
	},
}

const treeCss = {
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
	backgroundColor: colors.surface,
	minWidth: 0,
	viewTransitionName: 'files-tree',
	// 5rem clears the sticky site header, as on the timeline and account nav.
	position: 'sticky' as const,
	top: '5rem',
	[mq.tablet]: {
		position: 'static' as const,
	},
}

const treeHeadCss = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: spacing.sm,
	padding: `${spacing.md} ${spacing.md} ${spacing.sm}`,
}

const treeHeadingCss = {
	margin: 0,
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.semibold,
	letterSpacing: '0.02em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
}

const collapseButtonCss = {
	padding: spacing.xs,
	border: 'none',
	background: 'transparent',
	color: colors.textMuted,
	fontFamily: typography.fontFamily,
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.medium,
	cursor: 'pointer',
	'&:hover': { color: colors.text },
}

// Holds its space in the layout; `visibility` also drops it from the
// accessibility tree and out of tab order.
const collapseButtonHiddenCss = {
	...collapseButtonCss,
	visibility: 'hidden' as const,
}

const filterWrapCss = {
	padding: `0 ${spacing.md} ${spacing.sm}`,
}

// The icon is positioned against the input, not the padded wrapper around it —
// anchoring it to the wrapper puts it outside the field by the padding.
const filterFieldCss = {
	position: 'relative' as const,
	display: 'flex',
	alignItems: 'center',
}

const filterIconCss = {
	position: 'absolute' as const,
	left: '0.625rem',
	top: '50%',
	translate: '0 -50%',
	display: 'inline-flex',
	color: colors.textMuted,
	pointerEvents: 'none' as const,
}

const filterInputCss = {
	width: '100%',
	minWidth: 0,
	height: '2rem',
	padding: `0 ${spacing.sm} 0 1.875rem`,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.sm,
	backgroundColor: colors.background,
	color: colors.text,
	fontFamily: typography.fontFamily,
	fontSize: typography.fontSize.sm,
	boxSizing: 'border-box' as const,
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '-1px',
		borderColor: 'transparent',
	},
}

const treeScrollCss = {
	maxHeight: '38rem',
	overflowY: 'auto' as const,
	padding: `0 ${spacing.sm} ${spacing.sm}`,
	// Stacked above the file, the tree must not push the content off-screen.
	[mq.tablet]: {
		maxHeight: '18rem',
	},
}

const treeListCss = {
	margin: 0,
	padding: 0,
	listStyle: 'none',
	'& ul': {
		margin: 0,
		padding: 0,
		listStyle: 'none',
	},
}

const rowShellCss = {
	display: 'flex',
	alignItems: 'center',
	minWidth: 0,
}

const chevronButtonCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	flex: 'none',
	width: '1.25rem',
	height: '2rem',
	padding: 0,
	border: 'none',
	background: 'transparent',
	color: colors.textMuted,
	cursor: 'pointer',
	'&:hover': { color: colors.text },
}

const chevronSpacerCss = {
	flex: 'none',
	width: '1.25rem',
}

const chevronCss = {
	display: 'inline-flex',
	transition: `rotate ${transitions.fast}`,
	rotate: '0deg',
}

const chevronOpenCss = {
	...chevronCss,
	rotate: '90deg',
}

const rowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	flex: 1,
	minWidth: 0,
	height: '2rem',
	padding: `0 ${spacing.sm}`,
	borderRadius: radius.sm,
	color: colors.text,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.medium,
	textDecoration: 'none',
	'&:hover': {
		backgroundColor: colors.primarySoftest,
		color: colors.primaryText,
	},
}

const rowCurrentCss = {
	...rowCss,
	backgroundColor: colors.primarySoft,
	color: colors.primaryText,
	fontWeight: typography.fontWeight.semibold,
}

const rowIconCss = {
	display: 'inline-flex',
	flex: 'none',
	color: colors.textMuted,
}

const rowDirIconCss = {
	display: 'inline-flex',
	flex: 'none',
	color: colors.primaryText,
}

const rowNameCss = {
	flex: 1,
	minWidth: 0,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
}

const rowMetaCss = {
	flex: 'none',
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.normal,
	color: colors.textMuted,
}

const contentCss = {
	// Named so the file pane cross-fades in place instead of sliding up with
	// the page; its group is pinned so the box does not morph between the
	// old and new file's heights.
	viewTransitionName: 'files-blob',
	minWidth: 0,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
	backgroundColor: colors.surface,
	overflow: 'hidden',
}

const contentToolbarCss = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
	padding: `${spacing.sm} ${spacing.md}`,
	borderBottom: `1px solid ${colors.border}`,
}

const contentHeadingWrapCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	minWidth: 0,
	color: colors.textMuted,
}

const headingIconCss = {
	display: 'inline-flex',
	flex: 'none',
}

// `overflow-wrap: anywhere` broke the path one character per line as soon as
// the toolbar squeezed it; the path truncates instead, with the full location
// in the title tooltip and the tree alongside.
const contentHeadingCss = {
	margin: 0,
	minWidth: 0,
	fontFamily: typography.fontFamilyMono,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
}

const contentMetaCss = {
	flex: 'none',
	fontSize: typography.fontSize.xs,
	color: colors.textMuted,
	[mq.mobile]: {
		display: 'none',
	},
}

// Rendered markdown is prose, so it gets the reading inset the code view gets
// from its own gutter and `pre` padding.
const markdownCss = {
	...proseCss,
	padding: spacing.lg,
	// The panel supplies the inset, so the prose block adds none of its own and
	// the first block — a heading here, which `proseCss` only zeroes for a
	// leading paragraph — starts flush with the padding.
	marginTop: 0,
	'& > :first-child': {
		marginTop: 0,
	},
	// `proseCss` styles no tables. A README table sized to the column would
	// wrap every cell to a few characters, so it sizes to its content
	// (`max-content`) and scrolls inside its own box instead — the block
	// display is what lets a table overflow at all.
	'& table': {
		display: 'block',
		width: 'max-content',
		maxWidth: '100%',
		overflowX: 'auto',
		margin: '1.15rem 0 0',
		borderCollapse: 'collapse',
		fontSize: typography.fontSize.sm,
	},
	'& th, & td': {
		padding: `${spacing.sm} ${spacing.md}`,
		border: `1px solid ${colors.border}`,
		textAlign: 'left' as const,
		verticalAlign: 'top' as const,
	},
	'& th': {
		fontWeight: typography.fontWeight.semibold,
		backgroundColor: colors.background,
		whiteSpace: 'nowrap' as const,
	},
	'& td code': {
		whiteSpace: 'nowrap' as const,
	},
}

// Line numbers ride Shiki's own `.line` spans as a CSS counter, so the
// highlighter keeps emitting one flat token tree.
const codeCss = {
	'& pre': {
		margin: 0,
		padding: `${spacing.md} 0`,
		overflowX: 'auto' as const,
		fontFamily: typography.fontFamilyMono,
		fontSize: '0.8125rem',
		lineHeight: 1.55,
	},
	// Padding lives on `code`, not the .line spans, so the fallback output
	// (plaintext before the Shiki chunk resolves, or an oversized file) gets
	// the same gutters as highlighted lines.
	'& code': {
		display: 'block',
		paddingInline: spacing.md,
		counterReset: 'package-file-line',
	},
	'& .line': {
		display: 'block',
		counterIncrement: 'package-file-line',
	},
	'& .line:hover': {
		backgroundColor: colors.primarySoftest,
	},
	'& .line::before': {
		content: 'counter(package-file-line)',
		display: 'inline-block',
		width: '2.5rem',
		marginRight: spacing.md,
		textAlign: 'right' as const,
		color: colors.textMuted,
		opacity: 0.65,
		userSelect: 'none' as const,
	},
}

const emptyCss = {
	margin: `${spacing.sm} ${spacing.sm}`,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const dirListCss = {
	margin: 0,
	padding: 0,
	listStyle: 'none',
}

const dirLinkCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	padding: `0 ${spacing.md}`,
	height: '2.75rem',
	borderBottom: `1px solid ${colors.border}`,
	color: colors.text,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.medium,
	textDecoration: 'none',
	'&:hover': {
		backgroundColor: colors.primarySoftest,
		color: colors.primaryText,
	},
}
