/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { css } from 'remix/ui'
import { routes } from '#universal/routes.ts'
import { colors } from '#universal/styles/tokens.ts'
import { getPillButtonCss } from '#universal/styles/style-primitives.ts'

/**
 * Catalog and search-miss empty state for the community listings frame.
 * Rendered only when the resolved listings query is actually empty — not as
 * a loading placeholder, so first paint never flashes "no results."
 */
export function renderCommunityEmptyState(query: string | null) {
	const isSearch = Boolean(query)
	return (
		<div mix={css(emptyCss)} data-testid="community-listings-empty">
			<h2 mix={css(emptyTitleCss)}>
				{isSearch ? (
					'Nothing matched that search.'
				) : (
					<>
						The shelf is <em>waiting</em>.
					</>
				)}
			</h2>
			<p mix={css(emptyTextCss)}>
				{isSearch
					? 'No packages matched that name, description, or tag. Try a different search, or clear it and browse everything.'
					: 'Nobody has published a community package yet. Ask your agent to share something useful — forks keep their own history.'}
			</p>
			<p mix={css(emptyCtaCss)}>
				{isSearch ? (
					<a href={routes.community.href()} mix={css(getPillButtonCss())}>
						Clear search
					</a>
				) : (
					<a href={routes.onboarding.href()} mix={css(getPillButtonCss())}>
						Connect your agent
					</a>
				)}
			</p>
		</div>
	)
}

const emptyCss = {
	margin: 'clamp(2.2rem, 5vw, 3.5rem) 0 0',
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
