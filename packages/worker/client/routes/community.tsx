import { Frame, type Handle, css } from 'remix/ui'
import { routes } from '#app/routes.ts'
import { COMMUNITY_LISTINGS_TARGET } from '#app/community-frame-constants.ts'
import { type RouteLoaderResult } from '#client/route-loader.ts'
import {
	listenToRouterNavigation,
	readCurrentRouterHref,
} from '#client/client-router.tsx'
import { prefetchFrame } from '#client/frame-prefetch.ts'
import { spacing } from '#client/styles/tokens.ts'
import {
	fieldCss,
	fieldLabelCss,
	getPrimaryButtonCss,
	inputCss,
	layoutMaxWidths,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#client/styles/style-primitives.ts'
import { readCommunitySearchQueryFromHref } from '#client/routes/community-search.ts'

function isCommunityIndexPath(href: string) {
	const path = new URL(href, 'http://localhost').pathname
	return path === routes.community.href()
}

function buildCommunityListingsFrameSrc(href: string) {
	const url = new URL(href, 'http://localhost')
	return `${routes.community.href()}${url.search}`
}

export async function communityRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	try {
		const frameSrc = buildCommunityListingsFrameSrc(
			`${url.pathname}${url.search}`,
		)
		await prefetchFrame(frameSrc, COMMUNITY_LISTINGS_TARGET, signal)
	} catch {
		// Prefetch failures degrade to the post-commit frame fetch.
	}
	return {}
}

export function CommunityRoute(handle: Handle) {
	listenToRouterNavigation(handle, () => {
		const href = readCurrentRouterHref(handle)
		if (!isCommunityIndexPath(href)) return

		const frame = handle.frames.get(COMMUNITY_LISTINGS_TARGET)
		if (!frame) return

		const nextSrc = buildCommunityListingsFrameSrc(href)
		if (frame.src !== nextSrc) {
			frame.src = nextSrc
		}
		void frame.reload()
	})

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const searchQuery = readCommunitySearchQueryFromHref(currentHref)
		const frameSrc = buildCommunityListingsFrameSrc(currentHref)

		return (
			<section mix={css(pageCss)}>
				<header mix={css(pageHeaderCss)}>
					<h1 mix={css(pageTitleCss)}>Community packages</h1>
					<p mix={css(pageDescriptionCss)}>
						Browse packages shared by Kody users. Fork with your agent, adapt
						them to your goals, and rate your experience.
					</p>
				</header>

				<form
					method="get"
					action={routes.community.href()}
					mix={css(searchFormCss)}
				>
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

				<Frame name={COMMUNITY_LISTINGS_TARGET} src={frameSrc} />
			</section>
		)
	}
}

const pageCss = {
	...stackedPageCss,
	maxWidth: layoutMaxWidths.extended,
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
	minWidth: 'min(20rem, 100%)',
	maxWidth: '40rem',
}

const searchSubmitButtonCss = {
	flexShrink: 0,
}
