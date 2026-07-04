import { type Handle, css } from 'remix/ui'
import { createHref } from 'remix/route-pattern/href'
import { writeClipboardText } from '#client/clipboard.ts'
import { listenToRouterNavigation } from '#client/client-router.tsx'
import { on } from '#client/event-mixin.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, radius, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	insetCardCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
	textareaCss,
} from '#client/styles/style-primitives.ts'
import { type PublicCommunityListing } from '#client/routes/community-types.ts'

type CommunityDetailPayload = {
	ok: true
	listing: PublicCommunityListing
	loggedIn: boolean
	forkPrompt: string
}

type PageStatus = 'loading' | 'ready' | 'error'

const communityDetailPathPattern = '/community/:listingId'
const communityApiSuffix = '.json'

function getCurrentHref() {
	return typeof window === 'undefined' ? '/community' : window.location.href
}

function getCurrentListingId() {
	const url = new URL(getCurrentHref(), 'http://localhost')
	const prefix = '/community/'
	if (!url.pathname.startsWith(prefix)) return null
	const listingId = decodeURIComponent(
		url.pathname.slice(prefix.length).replace(/\/$/, ''),
	)
	return listingId || null
}

function buildDetailApiPath(listingId: string) {
	return createHref(`${communityDetailPathPattern}${communityApiSuffix}`, {
		listingId,
	})
}

function buildReportApiPath(listingId: string) {
	return createHref('/community/:listingId/report.json', { listingId })
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

function formatPublishedDate(value: string) {
	return new Date(value).toLocaleDateString()
}

function shortCommit(commit: string) {
	return commit.slice(0, 7)
}

export function CommunityDetailRoute(handle: Handle) {
	let status: PageStatus = 'loading'
	let listing: PublicCommunityListing | null = null
	let loggedIn = false
	let forkPrompt = ''
	let message: string | null = null
	let reportReason = ''
	let reportState: 'idle' | 'submitting' | 'success' | 'error' = 'idle'
	let reportMessage: string | null = null
	let copyState: 'idle' | 'copied' = 'idle'
	let copyResetTimerId: ReturnType<typeof window.setTimeout> | null = null
	let loadRequestId = 0
	let lastLoadedListingId: string | null = null

	async function loadCommunityDetail() {
		const listingId = getCurrentListingId()
		if (!listingId) {
			status = 'error'
			message = 'Community package not found.'
			handle.update()
			return
		}

		const requestId = ++loadRequestId
		try {
			const response = await fetch(buildDetailApiPath(listingId), {
				headers: { Accept: 'application/json' },
			})
			if (requestId !== loadRequestId) return
			if (response.status === 404) {
				status = 'error'
				message = 'Community package not found.'
				handle.update()
				return
			}
			const payload = await readJson<CommunityDetailPayload>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load community package.')
			}
			listing = payload.listing
			loggedIn = payload.loggedIn
			forkPrompt = payload.forkPrompt
			status = 'ready'
			message = null
			reportState = 'idle'
			reportMessage = null
			lastLoadedListingId = listingId
			handle.update()
		} catch (error) {
			if (requestId !== loadRequestId) return
			status = 'error'
			message =
				error instanceof Error
					? error.message
					: 'Unable to load community package.'
			handle.update()
		}
	}

	async function submitReport() {
		const listingId = getCurrentListingId()
		if (!listingId || reportState === 'submitting') return

		reportState = 'submitting'
		reportMessage = null
		handle.update()

		try {
			const response = await fetch(buildReportApiPath(listingId), {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({ reason: reportReason }),
			})
			const payload = await readJson<{ ok: boolean; error?: string }>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error ?? 'Unable to submit report.')
			}
			reportState = 'success'
			reportMessage = 'Report submitted. Thank you.'
			reportReason = ''
			handle.update()
		} catch (error) {
			reportState = 'error'
			reportMessage =
				error instanceof Error ? error.message : 'Unable to submit report.'
			handle.update()
		}
	}

	async function copyForkPrompt() {
		if (!forkPrompt) return
		try {
			await writeClipboardText(forkPrompt)
			if (copyResetTimerId != null) {
				window.clearTimeout(copyResetTimerId)
			}
			copyState = 'copied'
			handle.update()
			copyResetTimerId = window.setTimeout(() => {
				copyResetTimerId = null
				if (handle.signal.aborted) return
				copyState = 'idle'
				handle.update()
			}, 2000)
		} catch {
			copyState = 'idle'
			handle.update()
		}
	}

	listenToRouterNavigation(handle, () => {
		const listingId = getCurrentListingId()
		if (listingId !== lastLoadedListingId) {
			status = 'loading'
			handle.update()
		}
	})

	const primaryButtonCss = getPrimaryButtonCss()
	const secondaryButtonCss = getSecondaryButtonCss()

	return () => {
		const listingId = getCurrentListingId()
		if (
			status === 'loading' ||
			(listingId && listingId !== lastLoadedListingId)
		) {
			handle.queueTask(loadCommunityDetail)
		}

		if (status === 'loading') {
			return (
				<section mix={css(pageCss)}>
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading community package…
					</p>
				</section>
			)
		}

		if (status === 'error' || !listing) {
			return (
				<section mix={css(pageCss)}>
					<h1 mix={css(pageTitleCss)}>Community package not found</h1>
					<p mix={css(descriptionCss)}>
						{message ?? 'This listing is unavailable.'}
					</p>
					<p mix={css({ margin: 0 })}>
						<a href="/community" mix={css(mutedLinkCss)}>
							Back to community packages
						</a>
					</p>
				</section>
			)
		}

		return (
			<section mix={css(pageCss)}>
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
							<dd>{formatPublishedDate(listing.publishedAt)}</dd>
						</div>
						<div>
							<dt>Pinned commit</dt>
							<dd>
								<code>{shortCommit(listing.pinnedCommit)}</code>
							</dd>
						</div>
						<div>
							<dt>Rating</dt>
							<dd>{formatStars(listing.averageStars, listing.ratingCount)}</dd>
						</div>
						<div>
							<dt>Adaptation effort</dt>
							<dd>{formatAdaptationEffort(listing.averageAdaptationEffort)}</dd>
						</div>
						<div>
							<dt>Forks</dt>
							<dd>{listing.forkCount}</dd>
						</div>
					</dl>
				</section>

				<section mix={css(cardCss)}>
					<h2 mix={css(cardTitleCss)}>Fork with your agent</h2>
					<p mix={css(descriptionCss)}>
						Copy this prompt into your MCP-capable agent to fork and adapt the
						package safely.
					</p>
					<pre mix={css(promptBlockCss)}>{forkPrompt}</pre>
					<button
						mix={[
							on('click', () => void copyForkPrompt()),
							css(primaryButtonCss),
						]}
					>
						{copyState === 'copied' ? 'Copied' : 'Copy prompt'}
					</button>
				</section>

				{listing.readmeContent ? (
					<section mix={css(cardCss)}>
						<h2 mix={css(cardTitleCss)}>README</h2>
						<pre mix={css(readmeBlockCss)}>{listing.readmeContent}</pre>
					</section>
				) : null}

				<section mix={css(cardCss)}>
					<h2 mix={css(cardTitleCss)}>Report this listing</h2>
					{loggedIn ? (
						<>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Reason</span>
								<textarea
									value={reportReason}
									rows={4}
									maxLength={2000}
									placeholder="Describe why this listing should be reviewed."
									mix={[
										css(textareaCss),
										on('input', (event) => {
											reportReason = (event.target as HTMLTextAreaElement).value
											handle.update()
										}),
									]}
								/>
							</label>
							<button
								disabled={reportState === 'submitting' || !reportReason.trim()}
								mix={[
									on('click', () => void submitReport()),
									css(secondaryButtonCss),
								]}
							>
								{reportState === 'submitting' ? 'Submitting…' : 'Submit report'}
							</button>
							{reportMessage ? (
								<p
									mix={css({
										margin: 0,
										color:
											reportState === 'error' ? colors.error : colors.textMuted,
									})}
									role={reportState === 'error' ? 'alert' : 'status'}
								>
									{reportMessage}
								</p>
							) : null}
						</>
					) : (
						<p mix={css(descriptionCss)}>
							<a href="/login" mix={css(mutedLinkCss)}>
								Log in
							</a>{' '}
							to report this listing.
						</p>
					)}
				</section>
			</section>
		)
	}
}

const pageCss = {
	...stackedPageCss,
	maxWidth: '48rem',
	margin: '0 auto',
	width: '100%',
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

const promptBlockCss = {
	...insetCardCss,
	margin: 0,
	whiteSpace: 'pre-wrap' as const,
	wordBreak: 'break-word' as const,
	fontFamily: typography.fontFamily,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.6,
}

const readmeBlockCss = {
	...promptBlockCss,
	maxHeight: '32rem',
	overflow: 'auto',
}
