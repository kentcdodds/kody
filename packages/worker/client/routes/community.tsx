import { type Handle, css } from 'remix/ui'
import { listenToRouterNavigation } from '#client/client-router.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#client/styles/tokens.ts'
import {
	cardCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getPrimaryButtonCss,
	inputCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#client/styles/style-primitives.ts'
import { type PublicCommunityListing } from '#client/routes/community-types.ts'
import { readCommunitySearchQueryFromHref } from '#client/routes/community-search.ts'

type CommunityIndexPayload = {
	ok: true
	listings: Array<PublicCommunityListing>
	query: string | null
}

type PageStatus = 'loading' | 'ready' | 'error'

const communityApiPath = '/community.json'

function getCurrentHref() {
	return typeof window === 'undefined' ? '/community' : window.location.href
}

function formatStars(averageStars: number | null, ratingCount: number) {
	if (ratingCount <= 0) return 'No ratings yet'
	const stars = averageStars == null ? '—' : averageStars.toFixed(1)
	return `★ ${stars} (${ratingCount})`
}

function formatAdaptationEffort(value: number | null) {
	if (value == null) return '—'
	return value.toFixed(1)
}

export function CommunityRoute(handle: Handle) {
	let status: PageStatus = 'loading'
	let listings: Array<PublicCommunityListing> = []
	let message: string | null = null
	let loadRequestId = 0
	let lastLoadedHref = ''

	async function loadCommunityListings() {
		const href = getCurrentHref()
		const requestId = ++loadRequestId
		try {
			const url = new URL(href, 'http://localhost')
			const response = await fetch(
				`${communityApiPath}${url.search || '?limit=50'}`,
				{
					headers: { Accept: 'application/json' },
				},
			)
			if (requestId !== loadRequestId) return
			const payload = await readJson<CommunityIndexPayload>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load community packages.')
			}
			listings = payload.listings
			status = 'ready'
			message = null
			lastLoadedHref = href
			handle.update()
		} catch (error) {
			if (requestId !== loadRequestId) return
			status = 'error'
			listings = []
			message =
				error instanceof Error
					? error.message
					: 'Unable to load community packages.'
			handle.update()
		}
	}

	listenToRouterNavigation(handle, () => {
		const href = getCurrentHref()
		if (href !== lastLoadedHref) {
			status = 'loading'
			handle.update()
		}
	})

	return () => {
		const currentHref = getCurrentHref()
		const searchQuery = readCommunitySearchQueryFromHref(currentHref)
		if (status === 'loading' || currentHref !== lastLoadedHref) {
			handle.queueTask(loadCommunityListings)
		}

		return (
			<section mix={css(pageCss)}>
				<header mix={css(pageHeaderCss)}>
					<h1 mix={css(pageTitleCss)}>Community packages</h1>
					<p mix={css(pageDescriptionCss)}>
						Browse packages shared by Kody users. Fork with your agent, adapt
						them to your goals, and rate your experience.
					</p>
				</header>

				<form method="get" action="/community" mix={css(searchFormCss)}>
					<label mix={css(searchFieldCss)}>
						<span mix={css(fieldLabelCss)}>Search</span>
						<input
							key={searchQuery}
							type="search"
							name="q"
							defaultValue={searchQuery}
							placeholder="Search by name, description, or tags"
							mix={css(inputCss)}
						/>
					</label>
					<button
						type="submit"
						mix={css({ ...getPrimaryButtonCss(), ...searchSubmitButtonCss })}
					>
						Search
					</button>
				</form>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading community packages…
					</p>
				) : null}
				{message ? (
					<p mix={css({ color: colors.error, margin: 0 })} role="alert">
						{message}
					</p>
				) : null}

				{status === 'ready' && listings.length === 0 ? (
					<p mix={css(descriptionCss)}>
						{searchQuery
							? 'No community packages matched your search.'
							: 'No community packages have been published yet.'}
					</p>
				) : null}

				{status === 'ready' && currentHref === lastLoadedHref ? (
					<div mix={css(listingGridCss)}>
						{listings.map((listing) => (
							<article key={listing.id} mix={css(cardCss)}>
								<h2
									mix={css({
										margin: 0,
										fontSize: typography.fontSize.lg,
										fontWeight: typography.fontWeight.semibold,
									})}
								>
									<a
										href={`/community/${listing.id}`}
										mix={css({
											color: colors.primaryText,
											textDecoration: 'none',
										})}
									>
										{listing.name}
									</a>
								</h2>
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
								<dl mix={css(statsCss)}>
									<div>
										<dt>Rating</dt>
										<dd>
											{formatStars(listing.averageStars, listing.ratingCount)}
										</dd>
									</div>
									<div>
										<dt>Forks</dt>
										<dd>{listing.forkCount}</dd>
									</div>
									<div>
										<dt>Adaptation effort</dt>
										<dd>
											{formatAdaptationEffort(listing.averageAdaptationEffort)}
										</dd>
									</div>
								</dl>
							</article>
						))}
					</div>
				) : null}
			</section>
		)
	}
}

const pageCss = {
	...stackedPageCss,
	maxWidth: '72rem',
	margin: '0 auto',
	width: '100%',
}

const searchFormCss = {
	display: 'flex',
	gap: spacing.md,
	alignItems: 'end',
	flexWrap: 'wrap' as const,
	width: '100%',
}

const searchFieldCss = {
	...fieldCss,
	flex: 1,
	minWidth: '20rem',
	maxWidth: '40rem',
}

const searchSubmitButtonCss = {
	flexShrink: 0,
}

const listingGridCss = {
	display: 'grid',
	gap: spacing.lg,
	gridTemplateColumns: 'repeat(auto-fit, minmax(18rem, 1fr))',
	[mq.mobile]: {
		gridTemplateColumns: '1fr',
	},
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

const statsCss = {
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fit, minmax(8rem, 1fr))',
	gap: spacing.sm,
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
