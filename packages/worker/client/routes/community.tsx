import { Frame, type Handle, css } from 'remix/ui'
import { routes } from '#universal/routes.ts'
import { COMMUNITY_LISTINGS_TARGET } from '#universal/community-frame-constants.ts'
import { type RouteLoaderResult } from '#client/route-loader.ts'
import {
	listenToRouterNavigation,
	readCurrentRouterHref,
} from '#client/client-router.tsx'
import { prefetchFrame } from '#client/frame-prefetch.ts'
import { colors, transitions, typography } from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
	mergeCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import { readCommunitySearchQueryFromHref } from '#client/routes/community-search.ts'

/**
 * Community index, ported from the redesign prototype
 * (`landing/community.html`). The browse chrome (split head, search pill,
 * publish-back close) renders here; the listings stay server-rendered in the
 * `community-listings` frame exactly as before — this file only restyles the
 * shell around that architecture. Listing card styles live with the frame
 * content in `src/app/community-listings-content.tsx`.
 */

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
			<section mix={css(communityPageCss)}>
				<header mix={css(communityHeadCss)}>
					<div>
						<h1 data-rise style={{ '--rise': '0' }} mix={css(headTitleCss)}>
							Take what others
							<br />
							built. <em>Make it yours.</em>
						</h1>
						<p data-rise style={{ '--rise': '1' }} mix={css(headSubCss)}>
							Browse packages shared by Kody users. Fork with your agent, adapt
							them to your goals, and rate your experience.
						</p>
						<form
							data-rise
							data-focus-container
							style={{ '--rise': '2' }}
							role="search"
							method="get"
							action={routes.community.href()}
							mix={css(searchPillCss)}
						>
							<label htmlFor="pkg-q" mix={css(visuallyHiddenCss)}>
								Search community packages
							</label>
							<input
								id="pkg-q"
								key={searchQuery}
								type="search"
								name="q"
								defaultValue={searchQuery}
								placeholder="Search by name, description, or tags"
								mix={css(searchInputCss)}
							/>
							<button type="submit" mix={css(getPillButtonCss())}>
								Search
							</button>
						</form>
					</div>
					<img
						data-rise
						style={{ '--rise': '2' }}
						src="/images/kody-community-packages.webp"
						width={480}
						height={480}
						alt="Kody handing a wrapped package across a counter of neatly sorted parcels"
						mix={css(communityArtCss)}
					/>
				</header>

				<Frame
					name={COMMUNITY_LISTINGS_TARGET}
					src={frameSrc}
					fallback={
						<p role="status" mix={css(communityFrameFallbackCss)}>
							Loading community packages…
						</p>
					}
				/>

				<div mix={css(communityCloseCss)}>
					<p>
						Built something useful? Ask your agent to publish it back — every
						fork keeps its own history, and ratings come only from people who
						actually ran it.
					</p>
					<a href={routes.onboarding.href()} mix={css(closeButtonCss)}>
						Connect your agent
					</a>
				</div>
			</section>
		)
	}
}

/* ---------- styles ---------- */

/* The route owns its gutters — the app shell leaves redesigned marketing
   paths unpadded. 72rem browse measure. */
const communityPageCss = {
	maxWidth: '72rem',
	marginInline: 'auto',
	width: '100%',
	boxSizing: 'border-box' as const,
	padding:
		'clamp(3rem, 7vw, 5rem) clamp(1.25rem, 4vw, 2.5rem) clamp(4rem, 8vw, 6.5rem)',
}

/* Split head: browse pages earn Kody at their side, not overhead. The
   shirt-pattern whisper drifts toward the mascot. */
const communityHeadCss = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) clamp(150px, 22vw, 230px)',
	gap: 'clamp(1.5rem, 4vw, 3.5rem)',
	alignItems: 'center',
	position: 'relative' as const,
	// See `pageHeadCss`: the fabric is a backdrop, so it paints under the head.
	isolation: 'isolate' as const,
	'&::before': {
		content: '""',
		position: 'absolute' as const,
		zIndex: -1,
		inset: '-55% -14% -35%',
		background: `radial-gradient(ellipse 40% 65% at 82% 45%, oklch(from ${colors.text} l c h / 0.055), transparent 72%)`,
		maskImage: 'var(--kody-pattern)',
		maskPosition: 'center',
		maskSize: '340px',
		maskRepeat: 'repeat',
		WebkitMaskImage: 'var(--kody-pattern)',
		WebkitMaskPosition: 'center',
		WebkitMaskSize: '340px',
		WebkitMaskRepeat: 'repeat',
		pointerEvents: 'none' as const,
	},
	'@media (max-width: 720px)': {
		gridTemplateColumns: '1fr',
		textAlign: 'center' as const,
	},
}

const headTitleCss = {
	margin: 0,
	fontSize: 'clamp(2.4rem, 5vw, 3.4rem)',
	fontWeight: 760,
	letterSpacing: '-0.028em',
	lineHeight: 1.04,
	'& em': {
		fontStyle: 'normal',
		color: colors.primaryText,
	},
}

const headSubCss = {
	margin: '1rem 0 0',
	color: colors.textMuted,
	fontSize: '1.08rem',
	maxWidth: '46ch',
	textWrap: 'balance' as const,
	'@media (max-width: 720px)': {
		marginInline: 'auto',
	},
}

/* Search: the waitlist pill grammar, one field + one verb. */
const searchPillCss = {
	marginTop: '1.8rem',
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) auto',
	alignItems: 'stretch',
	width: 'min(100%, 34rem)',
	backgroundColor: colors.surface,
	border: `1.5px solid ${colors.border}`,
	borderRadius: '999px',
	padding: '0.3rem',
	transition: `border-color 160ms ${transitions.easeOut}, box-shadow 160ms ${transitions.easeOut}`,
	'&:focus-within': {
		borderColor: colors.primary,
		boxShadow: `0 0 0 3px oklch(from ${colors.primary} l c h / 0.25)`,
	},
	'@media (max-width: 720px)': {
		marginInline: 'auto',
	},
}

const searchInputCss = {
	font: `400 1rem/1.2 ${typography.fontFamilyBody}`,
	color: colors.text,
	backgroundColor: 'transparent',
	border: 'none',
	borderRadius: '999px',
	padding: '0.7rem 1.1rem',
	minWidth: 0,
	'&::placeholder': { color: colors.textMuted, opacity: 1 },
	'&:focus': { outline: 'none' },
	'&::-webkit-search-cancel-button': { WebkitAppearance: 'none' },
}

const communityArtCss = {
	width: '100%',
	height: 'auto',
	'@media (max-width: 720px)': {
		width: 'min(52%, 210px)',
		marginInline: 'auto',
		order: -1,
	},
}

/* Publish close: the community runs on forks coming back. */
const communityCloseCss = {
	marginTop: 'clamp(3rem, 7vw, 4.5rem)',
	paddingTop: 'clamp(1.8rem, 4vw, 2.5rem)',
	borderTop: `1px solid ${colors.border}`,
	display: 'flex',
	alignItems: 'center',
	gap: '1.2rem',
	flexWrap: 'wrap' as const,
	'& > p': {
		flex: 1,
		minWidth: '16rem',
		margin: 0,
		color: colors.textMuted,
		fontSize: '0.98rem',
	},
}

const communityFrameFallbackCss = {
	minHeight: '16rem',
	display: 'grid',
	placeItems: 'center',
	margin: 0,
	color: colors.textMuted,
}

const closeButtonCss = mergeCss(getGhostButtonCss(), {
	fontSize: '0.95rem',
	padding: '0.8rem 1.35rem',
})
