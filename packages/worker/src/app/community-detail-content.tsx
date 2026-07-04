/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type Handle, css } from 'remix/ui'
import { renderToString } from 'remix/ui/server'
import { type PublicCommunityListing } from '#app/community-public.ts'
import {
	formatCommunityAdaptationEffort,
	formatCommunityPublishedDate,
	formatCommunityStars,
	shortCommunityCommit,
} from '#app/community-display.ts'
import { colors, radius, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	descriptionCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
} from '#client/styles/style-primitives.ts'

export type CommunityDetailContentProps = {
	listing: PublicCommunityListing
}

export function CommunityDetailContent(
	handle: Handle<CommunityDetailContentProps>,
) {
	const { listing } = handle.props

	return () => (
		<div data-testid="community-detail-frame">
			<header mix={css(pageHeaderCss)}>
				<p mix={css({ margin: 0, color: colors.textMuted })}>
					<a href="/community" mix={css(mutedLinkCss)}>
						Community packages
					</a>
				</p>
				<h1 mix={css(pageTitleCss)}>{listing.name}</h1>
				<p mix={css(pageDescriptionCss)}>by @{listing.ownerUsername}</p>
			</header>

			<section mix={css(cardCss)}>
				<p mix={css(descriptionCss)}>{listing.description}</p>
				{listing.tags.length > 0 ? (
					<ul mix={css(tagListCss)}>
						{listing.tags.map((tag) => (
							<li key={tag} mix={css(tagPillCss)}>
								{tag}
							</li>
						))}
					</ul>
				) : null}
				<dl mix={css(metadataCss)}>
					<div>
						<dt>License</dt>
						<dd>{listing.license}</dd>
					</div>
					<div>
						<dt>Published</dt>
						<dd>{formatCommunityPublishedDate(listing.publishedAt)}</dd>
					</div>
					<div>
						<dt>Pinned commit</dt>
						<dd>
							<code>{shortCommunityCommit(listing.pinnedCommit)}</code>
						</dd>
					</div>
					<div>
						<dt>Rating</dt>
						<dd data-testid="community-detail-rating">
							{formatCommunityStars(listing.averageStars, listing.ratingCount)}
						</dd>
					</div>
					<div>
						<dt>Adaptation effort</dt>
						<dd>
							{formatCommunityAdaptationEffort(listing.averageAdaptationEffort)}
						</dd>
					</div>
					<div>
						<dt>Forks</dt>
						<dd data-testid="community-detail-forks">{listing.forkCount}</dd>
					</div>
				</dl>
			</section>
		</div>
	)
}

export async function renderCommunityDetailContentHtml(
	props: CommunityDetailContentProps,
) {
	return renderToString(<CommunityDetailContent {...props} />)
}

const tagListCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.xs,
	margin: 0,
	padding: 0,
	listStyle: 'none',
}

const tagPillCss = {
	padding: `${spacing.xs} ${spacing.sm}`,
	borderRadius: radius.full,
	backgroundColor: colors.primarySoftest,
	color: colors.primaryText,
	fontSize: typography.fontSize.sm,
}

const metadataCss = {
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))',
	gap: spacing.md,
	margin: 0,
	fontSize: typography.fontSize.sm,
	'& dt': {
		margin: 0,
		color: colors.textMuted,
		fontWeight: typography.fontWeight.medium,
	},
	'& dd': {
		margin: `${spacing.xs} 0 0`,
		color: colors.text,
	},
}
