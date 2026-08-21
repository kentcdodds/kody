/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { css } from 'remix/ui'
import { routes } from '#universal/routes.ts'
import {
	buildCommunityIndexHref,
	type CommunityListingSort,
} from '#universal/community-search.ts'
import { colors } from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'

function buildCreatePackagePrompt(query: string) {
	return `I searched Kody Community for "${query}" and found no published package. Create this package for me. First load coding_guide_get({ guide: "package_authoring" }) and coding_guide_get({ guide: "package_lifecycle" }). Then choose a suitable lower-kebab-case kody_id and call package_get_git_remote({ kody_id, create: true }) to create its repository. Build, test, and publish a useful package that matches my search.`
}

/**
 * Catalog and search-miss empty state for the community listings frame.
 * Rendered only when the resolved listings query is actually empty — not as
 * a loading placeholder, so first paint never flashes "no results."
 */
export function renderCommunityEmptyState(
	query: string | null,
	sort?: CommunityListingSort,
) {
	if (query) {
		const createPackagePrompt = buildCreatePackagePrompt(query)
		return (
			<div mix={css(emptyCss)} data-testid="community-listings-empty">
				<h2 mix={css(emptyTitleCss)}>Nothing matched that search.</h2>
				<p mix={css(emptyTextCss)}>
					No published community package matches <strong>{query}</strong> yet.
					You can ask your agent to create it.
				</p>
				<details mix={css(createPackageCss)}>
					<summary mix={css(getPillButtonCss())}>
						Ask your agent to create this package
					</summary>
					<div mix={css(promptPanelCss)}>
						<p mix={css(promptIntroCss)}>
							Copy this prompt into your MCP-capable agent:
						</p>
						<pre mix={css(promptCss)} data-testid="community-create-prompt">
							<code>{createPackagePrompt}</code>
						</pre>
					</div>
				</details>
				<p mix={css(secondaryCtaCss)}>
					<a
						href={routes.guideDetail.href({ slug: 'package-authoring' })}
						mix={css(getGhostButtonCss())}
					>
						Read the package authoring guide
					</a>
					<a
						href={buildCommunityIndexHref({ sort })}
						mix={css(secondaryLinkCss)}
					>
						Clear search
					</a>
				</p>
			</div>
		)
	}

	return (
		<div mix={css(emptyCss)} data-testid="community-listings-empty">
			<h2 mix={css(emptyTitleCss)}>
				The shelf is <em>waiting</em>.
			</h2>
			<p mix={css(emptyTextCss)}>
				Nobody has published a community package yet. Ask your agent to share
				something useful — forks keep their own history.
			</p>
			<p mix={css(emptyCtaCss)}>
				<a href={routes.onboarding.href()} mix={css(getPillButtonCss())}>
					Connect your agent
				</a>
			</p>
		</div>
	)
}

const emptyCss = {
	margin: '1.2rem 0 0',
	maxWidth: '40rem',
}

const emptyTitleCss = {
	margin: 0,
	fontSize: 'clamp(1.5rem, 2.8vw, 2rem)',
	fontWeight: 740,
	letterSpacing: '-0.022em',
	lineHeight: 1.12,
	'& em': {
		fontStyle: 'normal',
		color: colors.primaryText,
	},
}

const emptyTextCss = {
	margin: '0.9rem 0 0',
	color: colors.textMuted,
	maxWidth: '46ch',
	textWrap: 'pretty' as const,
}

const emptyCtaCss = {
	margin: '1.5rem 0 0',
}

const createPackageCss = {
	marginTop: '1.5rem',
	'&[open] > summary': {
		marginBottom: '0.9rem',
	},
	'& > summary': {
		cursor: 'pointer',
		listStyle: 'none',
		width: 'fit-content',
	},
	'& > summary::-webkit-details-marker': {
		display: 'none',
	},
}

const promptPanelCss = {
	padding: '1rem',
	backgroundColor: colors.surface,
	border: `1px solid ${colors.border}`,
	borderRadius: '0.8rem',
}

const promptIntroCss = {
	margin: '0 0 0.65rem',
	color: colors.textMuted,
	fontSize: '0.9rem',
}

const promptCss = {
	margin: 0,
	whiteSpace: 'pre-wrap' as const,
	overflowWrap: 'anywhere' as const,
	fontFamily: 'inherit',
	fontSize: '0.95rem',
	lineHeight: 1.55,
	userSelect: 'text' as const,
}

const secondaryCtaCss = {
	margin: '1rem 0 0',
	display: 'flex',
	alignItems: 'center',
	flexWrap: 'wrap' as const,
	gap: '0.9rem',
}

const secondaryLinkCss = {
	color: colors.primaryText,
	fontWeight: 650,
	textUnderlineOffset: '0.18em',
}
