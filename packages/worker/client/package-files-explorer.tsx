// remix-skill: Handle-based files explorer (tree + blob). Must be a Handle
// component so Remix can mount it from the shared /files route.
import { type Handle, type RemixNode, css } from 'remix/ui'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { renderMarkdownNodes } from '#client/markdown-view.tsx'
import { renderHighlightedCode } from '#client/syntax-highlight.tsx'
import {
	joinPackageFilesPath,
	listPackageFilesChildren,
} from '#universal/package-files.ts'
import { type PackageFilesLoaderData } from '#universal/loader-data.ts'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { proseCss } from '#universal/styles/style-primitives.ts'

export function PackageFilesExplorer(
	handle: Handle<{ data: PackageFilesLoaderData }>,
) {
	return () => {
		const { data } = handle.props
		return (
			<article mix={css(articleCss)} data-testid="package-files">
				<a href={data.backHref} mix={css(backLinkCss)}>
					← {data.backLabel}
				</a>
				<header mix={css(headCss)}>
					<h1 mix={css(titleCss)}>{data.title}</h1>
					<nav aria-label="Path" mix={css(breadcrumbCss)}>
						<a href={data.filesBasePath}>files</a>
						{data.ancestors.map((ancestor) => (
							<span key={ancestor.path}>
								<span mix={css(crumbSepCss)}>/</span>
								<a
									href={joinPackageFilesPath(data.filesBasePath, ancestor.path)}
								>
									{ancestor.name}
								</a>
							</span>
						))}
					</nav>
				</header>
				<div mix={css(layoutCss)}>
					<nav aria-label="Files" mix={css(treeCss)}>
						<h2 mix={css(treeHeadingCss)}>Files</h2>
						{renderTree(data.paths, '', data.selectedPath, data.filesBasePath)}
					</nav>
					<section mix={css(contentCss)} aria-label="Selected file">
						{renderContent(data)}
					</section>
				</div>
			</article>
		)
	}
}

function renderTree(
	paths: Array<string>,
	directoryPath: string,
	selectedPath: string,
	filesBasePath: string,
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
				return (
					<li key={child.path}>
						<a
							href={href}
							aria-current={current ? 'page' : undefined}
							mix={css(current ? treeLinkCurrentCss : treeLinkCss)}
						>
							{child.name}
							{child.kind === 'directory' ? '/' : ''}
						</a>
						{child.kind === 'directory'
							? renderTree(paths, child.path, selectedPath, filesBasePath)
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
				<h2 mix={css(contentHeadingCss)}>
					{data.selectedPath ? data.selectedPath : 'Package root'}
				</h2>
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
									{child.name}
									{child.kind === 'directory' ? '/' : ''}
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
				<h2 mix={css(contentHeadingCss)}>{heading}</h2>
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
				<div mix={css(proseCss)} data-testid="package-files-markdown">
					{renderMarkdownNodes(body)}
				</div>
			) : (
				<div data-testid="package-files-code">
					{renderHighlightedCode(body, data.language ?? 'plaintext')}
				</div>
			)}
		</div>
	)
}

const articleCss = {
	width: 'min(72rem, 100%)',
	margin: '0 auto',
	padding: `${spacing.xl} ${spacing.lg} ${spacing['2xl']}`,
}

const backLinkCss = {
	display: 'inline-flex',
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.medium,
	color: colors.primaryText,
	textDecoration: 'none',
	'&:hover': { color: colors.text },
}

const headCss = {
	marginTop: spacing.lg,
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

const breadcrumbCss = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
	overflowWrap: 'anywhere' as const,
	'& a': {
		color: colors.primaryText,
		textDecoration: 'none',
	},
}

const crumbSepCss = {
	margin: `0 ${spacing.xs}`,
	color: colors.textMuted,
}

const layoutCss = {
	display: 'grid',
	gridTemplateColumns: '18rem minmax(0, 1fr)',
	gap: spacing.lg,
	alignItems: 'start',
	[mq.mobile]: {
		gridTemplateColumns: '1fr',
	},
}

const treeCss = {
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
	padding: spacing.md,
	backgroundColor: colors.background,
	minWidth: 0,
}

const treeHeadingCss = {
	margin: `0 0 ${spacing.sm}`,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.semibold,
}

const treeListCss = {
	margin: 0,
	paddingLeft: spacing.md,
	listStyle: 'none',
	fontSize: typography.fontSize.sm,
	'& ul': {
		margin: 0,
		paddingLeft: spacing.md,
		listStyle: 'none',
	},
}

const treeLinkCss = {
	color: colors.text,
	textDecoration: 'none',
	overflowWrap: 'anywhere' as const,
	'&:hover': { color: colors.primaryText },
}

const treeLinkCurrentCss = {
	...treeLinkCss,
	fontWeight: typography.fontWeight.semibold,
	color: colors.primaryText,
}

const contentCss = {
	minWidth: 0,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
	padding: spacing.lg,
	backgroundColor: colors.background,
	'& pre': {
		overflowX: 'auto' as const,
	},
}

const contentToolbarCss = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: spacing.md,
	marginBottom: spacing.md,
}

const contentHeadingCss = {
	margin: 0,
	fontSize: typography.fontSize.base,
	fontWeight: typography.fontWeight.semibold,
	overflowWrap: 'anywhere' as const,
}

const emptyCss = {
	margin: 0,
	color: colors.textMuted,
}

const dirListCss = {
	margin: 0,
	paddingLeft: spacing.lg,
}

const dirLinkCss = {
	color: colors.primaryText,
	textDecoration: 'none',
}
