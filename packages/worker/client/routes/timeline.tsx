import { type Handle, css, on } from 'remix/ui'
import { communityActivityVerb } from '#universal/community-activity-display.ts'
import { renderCommunityListingName } from '#universal/community-listing-name.tsx'
import {
	type CommunityActivityEventType,
	type PublicCommunityActivityItem,
} from '#universal/community-public-types.ts'
import { type TimelineLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	type TimelineDay,
	type TimelineRun,
	formatTimelineEventTime,
	groupTimelineItems,
	timelineEventLimit,
} from '#universal/timeline-display.ts'
import { UserAvatar } from '#universal/user-avatar.tsx'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	colors,
	radius,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
	getSurfaceCardCss,
	inlineSpinnerCss,
	layoutMaxWidths,
	pageGutter,
	pageHeadCss,
} from '#universal/styles/style-primitives.ts'

/**
 * Timeline, ported from the redesign prototype (`landing/timeline.html`).
 *
 * A day-grouped feed: the date is written once per day in a sticky margin
 * column, and within a day consecutive events by the same actor collapse into
 * one "run" under a single avatar and name — so eleven pushes in one morning
 * read as one person working rather than eleven stamped copies of their face.
 * Each event row is threaded onto a drawn spine by its type glyph and carries
 * the time, which is what actually tells four updates to the same package
 * apart. Grouping and formatting live in `#universal/timeline-display.ts`.
 */

const timelineApiPath = routes.timelineApi.href()

function isTimelinePath(href: string) {
	return new URL(href, 'http://localhost').pathname === routes.timeline.href()
}

export async function timelineRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(timelineApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<TimelineLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load your timeline.')
	}
	return { timeline: payload }
}

export function TimelineRoute(handle: Handle) {
	let status: 'loading' | 'ready' | 'error' = 'loading'
	let items: Array<PublicCommunityActivityItem> = []
	const loadLatch = createRouteLoadLatch()

	async function loadTimeline() {
		status = 'loading'
		handle.update()
		try {
			const response = await fetch(timelineApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<TimelineLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load your timeline.')
			}
			items = payload.items
			status = 'ready'
			handle.update()
		} catch {
			status = 'error'
			handle.update()
		}
	}

	async function runLoad(href: string) {
		try {
			await loadTimeline()
			if (status === 'ready') loadLatch.markLoaded(href)
			else loadLatch.markFailed(href)
		} catch {
			loadLatch.markFailed(href)
		}
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		if (!isTimelinePath(currentHref)) {
			return <section mix={css(pageCss)} />
		}

		const routeData = tryConsumeRouteLoaderData(handle, 'timeline', currentHref)
		const appliedRouteData = Boolean(routeData?.ok)
		if (routeData?.ok) {
			items = routeData.items
			status = 'ready'
			loadLatch.markLoaded(currentHref)
		}

		const needsStaleRefresh = consumeStaleNavigationData(currentHref)
		const needsLoad = loadLatch.needsLoad({
			currentHref,
			isLoading: status === 'loading',
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			handle.queueTask(async () => {
				await runLoad(currentHref)
			})
		}

		const days = status === 'ready' ? groupTimelineItems(items) : []

		return (
			<section mix={css(pageCss)} data-testid="timeline-page">
				<header mix={css(headCss)}>
					<h1 data-rise style={{ '--rise': '0' }}>
						What the people you follow <em>shipped</em>.
					</h1>
					<p data-rise style={{ '--rise': '1' }}>
						Public activity from every account you follow: community publishes
						and republishes, forks, and stars. Package edits that were never
						republished do not show up. The {timelineEventLimit} most recent,
						newest first.
					</p>
				</header>

				{status === 'loading' ? (
					<p mix={css(loadingCss)} role="status">
						<span mix={css(inlineSpinnerCss)} aria-hidden="true" />
						Loading your timeline…
					</p>
				) : null}

				{status === 'error' ? (
					<div mix={css(errorCardCss)} role="alert">
						<h2 mix={css(errorTitleCss)}>We couldn't load your timeline.</h2>
						<p mix={css(errorTextCss)}>
							Nothing is lost — the activity is still there. Try again, and if
							it keeps failing the community page still works.
						</p>
						<p mix={css(errorActionsCss)}>
							<button
								type="button"
								mix={[
									css(getPillButtonCss()),
									on('click', () => {
										void runLoad(currentHref)
									}),
								]}
							>
								Try again
							</button>
							<a href={routes.community.href()} mix={css(getGhostButtonCss())}>
								Go to community
							</a>
						</p>
					</div>
				) : null}

				{status === 'ready' && days.length === 0 ? (
					<div mix={css(emptyCss)} data-testid="timeline-empty">
						<div>
							<h2 mix={css(emptyTitleCss)}>
								Your timeline starts with a <em>follow</em>.
							</h2>
							<p mix={css(emptyTextCss)}>
								Everything the people you follow publish, update, fork, or star
								lands here, newest first. Nobody is on your list yet, so the
								page is waiting.
							</p>
							<p mix={css(emptyTextCss)}>
								Start where the packages are: open a listing you like and follow
								whoever built it.
							</p>
							<p mix={css(emptyCtaCss)}>
								<a href={routes.community.href()} mix={css(getPillButtonCss())}>
									Browse community packages
								</a>
							</p>
						</div>
						<img
							src="/images/kody-lantern.webp"
							width={640}
							height={640}
							loading="lazy"
							alt="Kody holding up a lantern with a constellation glowing inside it, surrounded by floating notes and parcels"
							mix={css(emptyArtCss)}
						/>
					</div>
				) : null}

				{status === 'ready' && days.length > 0 ? (
					<div mix={css(feedCss)}>
						{days.map((day) => renderDay(day))}
						{items.length >= timelineEventLimit ? (
							<p mix={css(endNoteCss)}>
								That is the last of the {timelineEventLimit} most recent events.
							</p>
						) : null}
					</div>
				) : null}
			</section>
		)
	}
}

/* ---------- feed pieces ---------- */

function renderDay(day: TimelineDay) {
	const headingId = `timeline-day-${day.dayKey}`
	return (
		<section key={day.dayKey} mix={css(dayCss)} aria-labelledby={headingId}>
			<h2 id={headingId} mix={css(dayDateCss)}>
				<time dateTime={day.dayKey}>{day.dayLabel}</time>
			</h2>
			<div>{day.runs.map((run, index) => renderRun(day, run, index))}</div>
		</section>
	)
}

function renderRun(day: TimelineDay, run: TimelineRun, index: number) {
	return (
		<article
			key={`${day.dayKey}:${index}:${run.actorUsername}`}
			mix={css(runCss)}
		>
			<h3 mix={css(runHeadCss)}>
				<a
					href={routes.profile.href({ username: run.actorUsername })}
					mix={css(actorLinkCss)}
				>
					<UserAvatar
						displayName={run.actorDisplayName}
						avatarUrl={run.actorAvatarUrl}
						size={32}
						variant="well"
					/>
					<span mix={css(actorNameCss)}>{run.actorDisplayName}</span>
				</a>
			</h3>
			{/* No `role="list"` despite `list-style: none` (the prototype's
			    VoiceOver hedge): the repo lints redundant roles and every other
			    unstyled list here — the blog index, the community grid — omits it,
			    so the timeline stays consistent with them. */}
			<ol mix={css(eventListCss)}>
				{run.events.map((event) => renderEvent(event))}
			</ol>
		</article>
	)
}

function renderEvent(event: PublicCommunityActivityItem) {
	const published = event.type === 'listing_published'
	return (
		<li
			key={`${event.type}:${event.listingId}:${event.createdAt}`}
			mix={css(eventCss)}
			data-published={published ? 'true' : undefined}
		>
			<a
				href={routes.communityDetail.href({ listingId: event.listingId })}
				mix={css(eventLinkCss)}
			>
				<span data-timeline-glyph mix={css(glyphCss)}>
					{renderEventIcon(event.type)}
				</span>
				<span mix={css(whatCss)}>
					<span mix={css(verbCss)}>{communityActivityVerb(event.type)}</span>
					<span data-timeline-listing mix={css(listingCss)}>
						{renderCommunityListingName(event.listingName)}
					</span>
				</span>
				<time dateTime={event.createdAt} mix={css(timeCss)}>
					{formatTimelineEventTime(event.createdAt)}
				</time>
			</a>
		</li>
	)
}

/* ---------- event glyphs ----------
   Inlined rather than sprited (the app does not use SVG sprites — see
   `client/provider-icons.tsx`). Always aria-hidden: the verb word beside each
   glyph already says which event this is, so color and shape only reinforce. */

const glyphAttrs = {
	viewBox: '0 0 16 16',
	'aria-hidden': true,
	focusable: false,
	fill: 'none',
	stroke: 'currentColor',
	strokeLinecap: 'round' as const,
	strokeLinejoin: 'round' as const,
}

function renderEventIcon(type: CommunityActivityEventType) {
	switch (type) {
		case 'listing_published':
			return (
				<svg {...glyphAttrs} strokeWidth="1.6">
					<path d="M8 10.5V2.6M4.9 5.7 8 2.6l3.1 3.1M2.9 13.4h10.2" />
				</svg>
			)
		case 'listing_updated':
			return (
				<svg {...glyphAttrs} strokeWidth="1.6">
					<path d="M13.2 8a5.2 5.2 0 1 1-1.75-3.9M13.4 2.6v2.9h-2.9" />
				</svg>
			)
		case 'listing_forked':
			return (
				<svg {...glyphAttrs} strokeWidth="1.6">
					<circle cx="4.4" cy="3.6" r="1.6" />
					<circle cx="11.6" cy="3.6" r="1.6" />
					<circle cx="8" cy="12.4" r="1.6" />
					<path d="M4.4 5.2v1.2a2 2 0 0 0 2 2h3.2a2 2 0 0 0 2-2V5.2M8 8.4v2.4" />
				</svg>
			)
		case 'listing_starred':
			return (
				<svg {...glyphAttrs} strokeWidth="1.5">
					<path d="m8 2.4 1.73 3.5 3.87.56-2.8 2.73.66 3.85L8 11.23l-3.46 1.81.66-3.85-2.8-2.73 3.87-.56z" />
				</svg>
			)
		default: {
			const _exhaustive: never = type
			return _exhaustive
		}
	}
}

/* ---------- styles ---------- */

const pageCss = {
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	padding: `clamp(3rem, 7vw, 5rem) ${pageGutter} clamp(4rem, 8vw, 6.5rem)`,
	// The head's whisper bleeds wider than its box on purpose; `clip` keeps
	// that bleed from becoming a sideways scrollbar without turning the page
	// into a scroll container (which would break the sticky dates).
	overflowX: 'clip' as const,
}

/* A feed is read, not browsed: the head sits left like the blog index. */
const headCss = {
	...pageHeadCss,
	textAlign: 'left' as const,
	'&::before': {
		...pageHeadCss['&::before'],
		inset: '-80% -20% -120%',
		background: `radial-gradient(ellipse 40% 55% at 32% 40%, oklch(from ${colors.text} l c h / 0.05), transparent 72%)`,
	},
	'& h1': {
		...pageHeadCss['& h1'],
		fontSize: 'clamp(2.1rem, 4.4vw, 3.1rem)',
		lineHeight: 1.06,
		maxWidth: '18ch',
	},
	'& > p': {
		...pageHeadCss['& > p'],
		marginInline: 0,
		maxWidth: '54ch',
		textWrap: 'pretty' as const,
	},
}

/* Reading measure, not the 72rem browse width the card grid earns. */
const feedCss = {
	width: 'min(100%, 56rem)',
	marginTop: 'clamp(2.5rem, 6vw, 3.5rem)',
}

/* The day is the spine: parking the date in the margin writes it once
   instead of stamping the same absolute date on every row, and frees the row
   itself to carry a time. */
const dayCss = {
	display: 'grid',
	gridTemplateColumns: '8rem minmax(0, 1fr)',
	gap: 'clamp(0.9rem, 3vw, 2rem)',
	paddingBlock: 'clamp(1.5rem, 3vw, 2.1rem)',
	borderTop: `1px solid ${colors.border}`,
	'&:first-child': {
		borderTop: 'none',
		paddingTop: 0,
	},
	// The date stops being a margin note and becomes the group's own line.
	'@media (max-width: 720px)': {
		gridTemplateColumns: '1fr',
		gap: '0.7rem',
	},
}

const dayDateCss = {
	margin: 0,
	font: `650 0.95rem/1.4 ${typography.fontFamilyDisplay}`,
	color: colors.textMuted,
	textAlign: 'right' as const,
	alignSelf: 'start',
	// Stays with you through a long day; 5rem clears the sticky site header.
	position: 'sticky' as const,
	top: '5rem',
	'@media (max-width: 720px)': {
		textAlign: 'left' as const,
		position: 'static' as const,
	},
}

/* One identity per run: the avatar is the node the day's events hang from. */
const runCss = {
	position: 'relative' as const,
	'&:not(:first-child)': {
		marginTop: '1.5rem',
	},
}

const runHeadCss = {
	margin: 0,
}

const actorLinkCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.6rem',
	maxWidth: '100%',
	font: `700 1rem/1.3 ${typography.fontFamilyDisplay}`,
	letterSpacing: '-0.012em',
	color: colors.text,
	textDecoration: 'none',
	transition: `color 160ms ${transitions.easeOut}`,
	'&:hover': {
		color: colors.primaryText,
	},
	'@media (prefers-reduced-motion: reduce)': {
		transition: 'none',
	},
}

const actorNameCss = {
	minWidth: 0,
}

const eventListCss = {
	listStyle: 'none',
	margin: '0.5rem 0 0',
	padding: 0,
}

/**
 * The spine is drawn per row rather than as one line down the run, so it
 * always ends on the last node: each row draws up to its own glyph, and only
 * a row with a successor draws onward. Rows that wrap to two lines on a phone
 * stay threaded, with no magic offset to keep in sync.
 */
const eventCss = {
	position: 'relative' as const,
	'&::before, &:not(:last-child)::after': {
		content: '""',
		position: 'absolute' as const,
		left: '1rem',
		width: '1px',
		backgroundColor: colors.border,
	},
	// Up from the row's top edge to its glyph, at the row's middle.
	'&::before': { top: 0, bottom: '50%' },
	// The first row reaches back under the avatar, across the list's margin.
	'&:first-child::before': { top: '-0.6rem' },
	// On down to the next node.
	'&:not(:last-child)::after': { top: '50%', bottom: 0 },
}

/**
 * The whole row is the link: one tab stop per event, and every link name
 * ("Updated @kody/fathom-analytics 04:29") is unique, which a bare listing
 * name repeated four times is not.
 */
const eventLinkCss = {
	display: 'grid',
	gridTemplateColumns: '2rem minmax(0, 1fr) auto',
	alignItems: 'center',
	gap: '0.2rem 0.7rem',
	padding: '0.4rem 0.7rem 0.4rem 0',
	borderRadius: '10px',
	color: colors.text,
	textDecoration: 'none',
	transition: `background-color 160ms ${transitions.easeOut}`,
	'&:hover': {
		backgroundColor: colors.surface,
	},
	'&:hover [data-timeline-listing]': {
		color: colors.primaryText,
	},
	// The row keeps its 10px corners when focused via the unlayered
	// `[data-rounded-focus]` rule in public/styles.css — a rule here could not
	// win against the global unlayered `:focus-visible`.
	'@media (max-width: 720px)': {
		paddingRight: '0.4rem',
	},
	'@media (prefers-reduced-motion: reduce)': {
		transition: 'none',
	},
}

/**
 * The well punches a hole in the spine so the line threads the glyphs rather
 * than crossing them. The spine is an absolutely-positioned pseudo-element,
 * which paints above static content — so the well has to be positioned too,
 * or the line draws straight over its background.
 */
const glyphCss = {
	position: 'relative' as const,
	zIndex: 1,
	justifySelf: 'center',
	display: 'grid',
	placeItems: 'center',
	width: '1.45rem',
	height: '1.45rem',
	boxSizing: 'border-box' as const,
	borderRadius: radius.full,
	backgroundColor: colors.background,
	border: `1px solid ${colors.border}`,
	color: colors.textMuted,
	'& svg': {
		width: '0.82rem',
		height: '0.82rem',
	},
	// Publishing is the only event that puts a new thing into the world, so it
	// takes the accent. The verb word says the same in text — the color is
	// reinforcement, never the only carrier.
	//
	// Keyed off the row from inside the glyph's own object on purpose: every
	// css() class gets its own `@layer rmx.<class>`, and later-created classes
	// win over earlier ones no matter how specific the earlier selector is. As
	// a rule on the row this lost to the glyph's own base color every time.
	'[data-published] &': {
		color: colors.primaryText,
		borderColor: `oklch(from ${colors.primary} l c h / 0.5)`,
		backgroundColor: `oklch(from ${colors.primary} l c h / 0.12)`,
	},
}

const whatCss = {
	minWidth: 0,
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'baseline',
	gap: '0 0.5rem',
}

const verbCss = {
	color: colors.textMuted,
	fontSize: '0.92rem',
}

const listingCss = {
	font: `650 1rem/1.45 ${typography.fontFamilyDisplay}`,
	letterSpacing: '-0.012em',
	transition: `color 160ms ${transitions.easeOut}`,
	'@media (prefers-reduced-motion: reduce)': {
		transition: 'none',
	},
}

const timeCss = {
	color: colors.textMuted,
	fontSize: '0.88rem',
	fontVariantNumeric: 'tabular-nums',
}

/* The 50-row ceiling is a fact of the feed, so it says so rather than
   trailing off into a scroll that never loads more. */
const endNoteCss = {
	margin: '1.8rem 0 0',
	color: colors.textMuted,
	fontSize: '0.92rem',
}

/* ---------- empty ---------- */

const emptyCss = {
	width: 'min(100%, 56rem)',
	marginTop: 'clamp(2.5rem, 6vw, 3.5rem)',
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) clamp(150px, 24vw, 240px)',
	gap: 'clamp(1.5rem, 4vw, 3rem)',
	alignItems: 'center',
	'@media (max-width: 720px)': {
		gridTemplateColumns: '1fr',
	},
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

const emptyArtCss = {
	width: '100%',
	height: 'auto',
	'@media (max-width: 720px)': {
		width: 'min(46%, 190px)',
		marginInline: 'auto',
		order: -1,
	},
}

/* ---------- loading ---------- */

const loadingCss = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.7rem',
	margin: 'clamp(2.5rem, 6vw, 3.5rem) 0 0',
	color: colors.textMuted,
}

/* ---------- error ---------- */

const errorCardCss = {
	...getSurfaceCardCss(),
	width: 'min(100%, 44rem)',
	marginTop: 'clamp(2.5rem, 6vw, 3.5rem)',
	padding: 'clamp(1.3rem, 3vw, 1.8rem)',
}

const errorTitleCss = {
	margin: 0,
	fontSize: '1.25rem',
	fontWeight: 720,
	letterSpacing: '-0.015em',
}

const errorTextCss = {
	margin: '0.6rem 0 0',
	color: colors.textMuted,
}

const errorActionsCss = {
	margin: '1.2rem 0 0',
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: '0.6rem',
}
