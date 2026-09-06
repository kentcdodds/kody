import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import {
	readRouterPathname,
	readRouterSearch,
} from '#client/router-location.tsx'
import { type SiteBannerLoaderData } from '#universal/loader-data.ts'
import {
	isSiteBannerId,
	resolveVisibleSiteBanner,
	siteBannerLookMinHeights,
	type SiteBannerIcon,
	type SiteBannerLook,
	type SiteBannerSeverity,
	type SiteBannerView,
} from '#universal/site-banners.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
	hoverMq,
	layoutMaxWidths,
	pageGutter,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

export type SiteBannerFrameProps = {
	banner: SiteBannerView
	onDismiss?: () => void
	preview?: boolean
}

const emptyViewer = {
	loggedIn: false,
	stableUserId: null,
	plan: null,
	isAdmin: false,
} as const

export function emptySiteBannerSnapshot(): SiteBannerLoaderData {
	return {
		banner: null,
		candidates: [],
		dismissedIds: [],
		viewer: emptyViewer,
	}
}

export function SiteBanner(
	handle: Handle<{ snapshot?: SiteBannerLoaderData }>,
) {
	let extraDismissedIds: Array<string> = []
	let dismissInFlight = false

	async function dismiss(banner: SiteBannerView) {
		if (!banner.dismissible || dismissInFlight) return
		dismissInFlight = true
		extraDismissedIds = [...extraDismissedIds, banner.id]
		handle.update()
		if (!isSiteBannerId(banner.id)) {
			dismissInFlight = false
			return
		}
		try {
			await fetch('/site-banner-dismiss.json', {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({ bannerId: banner.id }),
			})
		} catch {
			// Cookie/D1 persist is best-effort; the local hide already applied.
		} finally {
			dismissInFlight = false
		}
	}

	return () => {
		const snapshot = handle.props.snapshot ?? emptySiteBannerSnapshot()
		const search = readRouterSearch(handle)
		const searchParams = new URLSearchParams(
			search.startsWith('?') ? search.slice(1) : search,
		)
		const banner = resolveVisibleSiteBanner({
			candidates: snapshot.candidates,
			dismissedIds: [...snapshot.dismissedIds, ...extraDismissedIds],
			pathname: readRouterPathname(handle),
			searchParams,
			viewer: snapshot.viewer,
		})
		if (!banner) return null
		return (
			<SiteBannerFrame
				banner={banner}
				onDismiss={banner.dismissible ? () => void dismiss(banner) : undefined}
			/>
		)
	}
}

export function SiteBannerFrame(handle: Handle<SiteBannerFrameProps>) {
	const ctaButtonCss = getPillButtonCss({ size: 'sm' })
	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })

	return () => {
		const { banner, onDismiss, preview } = handle.props
		const look = banner.look
		const dismissible = Boolean(onDismiss && banner.dismissible)
		const titleId = `${handle.id}-site-banner-title`
		const tone = severityTone(banner.severity)

		return (
			<section
				data-testid={preview ? `site-banner-preview-${look}` : 'site-banner'}
				data-look={look}
				data-severity={banner.severity}
				aria-labelledby={titleId}
				mix={css(shellCss(look, tone))}
			>
				<div mix={css(innerCss(look))}>
					{renderMedia(banner, look, tone)}
					<div mix={css(copyCss(look))}>
						<p id={titleId} mix={css(titleCss(look))}>
							{banner.title}
						</p>
						{banner.body ? <p mix={css(bodyCss(look))}>{banner.body}</p> : null}
					</div>
					<div mix={css(actionsCss(look))}>
						{banner.ctaHref && banner.ctaLabel ? (
							<a href={banner.ctaHref} mix={css(ctaButtonCss)}>
								{banner.ctaLabel}
							</a>
						) : null}
						{banner.secondaryHref && banner.secondaryLabel ? (
							<a href={banner.secondaryHref} mix={css(secondaryButtonCss)}>
								{banner.secondaryLabel}
							</a>
						) : null}
					</div>
					{dismissible ? (
						<button
							type="button"
							aria-label="Dismiss announcement"
							mix={[css(dismissCss), on('click', () => onDismiss?.())]}
						>
							×
						</button>
					) : null}
				</div>
			</section>
		)
	}
}

function renderMedia(
	banner: SiteBannerView,
	look: SiteBannerLook,
	tone: SeverityTone,
) {
	if (banner.imageUrl) {
		return (
			<img
				src={banner.imageUrl}
				alt=""
				width={look === 'card' ? 72 : 40}
				height={look === 'card' ? 72 : 40}
				mix={css(imageCss(look))}
			/>
		)
	}
	return (
		<span aria-hidden="true" mix={css(iconWellCss(look, tone))}>
			{iconGlyph(banner.icon ?? defaultIcon(look))}
		</span>
	)
}

function defaultIcon(look: SiteBannerLook): SiteBannerIcon {
	switch (look) {
		case 'promo':
		case 'card':
			return 'play'
		case 'strip':
			return 'megaphone'
		default: {
			const exhaustive: never = look
			return exhaustive
		}
	}
}

function iconGlyph(icon: SiteBannerIcon) {
	switch (icon) {
		case 'play':
			return '▶'
		case 'megaphone':
			return '📣'
		case 'sparkle':
			return '✦'
		case 'info':
			return 'ℹ'
		default: {
			const exhaustive: never = icon
			return exhaustive
		}
	}
}

type SeverityTone = {
	accent: string
	soft: string
	ink: string
}

function severityTone(severity: SiteBannerSeverity): SeverityTone {
	switch (severity) {
		case 'warning':
			return {
				accent: colors.warning,
				soft: `color-mix(in srgb, ${colors.warning} 16%, ${colors.surface})`,
				ink: colors.warningText,
			}
		case 'success':
			return {
				accent: colors.primary,
				soft: colors.primarySoft,
				ink: colors.primaryText,
			}
		case 'promo':
			return {
				accent: colors.primary,
				soft: colors.primarySoftStrong,
				ink: colors.primaryText,
			}
		case 'info':
			return {
				accent: colors.primary,
				soft: colors.primarySoftest,
				ink: colors.primaryText,
			}
		default: {
			const exhaustive: never = severity
			return exhaustive
		}
	}
}

const stackMq = '@media (max-width: 720px)'

function shellCss(look: SiteBannerLook, tone: SeverityTone) {
	const minHeight = siteBannerLookMinHeights[look]
	const shared = {
		// Full-bleed chrome: gutters live on the inner row so the painted
		// shell spans the app column. min-width:0 avoids a flex item growing
		// past that column when an ancestor clips overflow-x.
		width: '100%',
		maxWidth: '100%',
		minWidth: 0,
		alignSelf: 'stretch' as const,
		margin: 0,
		boxSizing: 'border-box' as const,
		minHeight,
	}
	switch (look) {
		case 'strip':
			return {
				...shared,
				paddingBlock: '0.45rem',
				paddingInline: 0,
				borderBottom: `1px solid ${colors.border}`,
				backgroundColor: tone.soft,
			}
		case 'promo':
			return {
				...shared,
				paddingBlock: '0.85rem',
				paddingInline: 0,
				borderBottom: `1px solid ${colors.border}`,
				// Solid tint to the viewport edge. A fade-to-surface read as
				// the strip being inset or clipped on the right.
				backgroundColor: tone.soft,
			}
		case 'card':
			return {
				...shared,
				padding: `${spacing.md} ${pageGutter}`,
				backgroundColor: colors.background,
			}
		default: {
			const exhaustive: never = look
			return exhaustive
		}
	}
}

function innerCss(look: SiteBannerLook) {
	const shared = {
		width: '100%',
		margin: '0 auto',
		display: 'flex',
		alignItems: 'center',
		boxSizing: 'border-box' as const,
		position: 'relative' as const,
	}
	switch (look) {
		case 'strip':
			return {
				...shared,
				maxWidth: layoutMaxWidths.wide,
				paddingInline: pageGutter,
				gap: spacing.md,
				[stackMq]: {
					flexWrap: 'wrap' as const,
					alignItems: 'flex-start',
					gap: spacing.sm,
					paddingInlineEnd: '1.75rem',
				},
			}
		case 'promo':
			return {
				...shared,
				maxWidth: layoutMaxWidths.extended,
				paddingInline: pageGutter,
				gap: spacing.lg,
				[stackMq]: {
					flexWrap: 'wrap' as const,
					alignItems: 'flex-start',
					gap: spacing.md,
					paddingInlineEnd: '1.75rem',
				},
			}
		case 'card':
			return {
				...shared,
				maxWidth: layoutMaxWidths.content,
				gap: spacing.lg,
				padding: `${spacing.lg} ${spacing.xl}`,
				backgroundColor: colors.surface,
				border: `1px solid ${colors.border}`,
				borderRadius: radius.card,
				boxShadow: shadows.sm,
				[stackMq]: {
					flexWrap: 'wrap' as const,
					alignItems: 'flex-start',
					gap: spacing.md,
					padding: spacing.md,
					paddingInlineEnd: '2rem',
				},
			}
		default: {
			const exhaustive: never = look
			return exhaustive
		}
	}
}

function copyCss(look: SiteBannerLook) {
	return {
		display: 'grid',
		gap: look === 'strip' ? '0.1rem' : '0.25rem',
		flex: '1 1 16rem',
		minWidth: 0,
	}
}

function titleCss(look: SiteBannerLook) {
	return {
		margin: 0,
		color: colors.text,
		fontFamily: typography.fontFamilyDisplay,
		fontWeight: typography.fontWeight.semibold,
		fontSize:
			look === 'strip'
				? typography.fontSize.sm
				: look === 'promo'
					? typography.fontSize.lg
					: typography.fontSize.xl,
		lineHeight: 1.25,
	}
}

function bodyCss(look: SiteBannerLook) {
	return {
		margin: 0,
		color: colors.textMuted,
		fontSize:
			look === 'strip' ? typography.fontSize.xs : typography.fontSize.sm,
		lineHeight: 1.4,
		[stackMq]:
			look === 'strip'
				? {
						display: 'none',
					}
				: {},
	}
}

function actionsCss(look: SiteBannerLook) {
	return {
		display: 'flex',
		flexWrap: 'wrap' as const,
		alignItems: 'center',
		gap: spacing.sm,
		flex: look === 'strip' ? '0 1 auto' : '0 0 auto',
		[stackMq]: {
			width: '100%',
		},
	}
}

function imageCss(look: SiteBannerLook) {
	const size =
		look === 'card' ? '4.5rem' : look === 'promo' ? '3.25rem' : '2rem'
	return {
		width: size,
		height: size,
		borderRadius: look === 'card' ? radius.md : radius.full,
		objectFit: 'cover' as const,
		flex: '0 0 auto',
		backgroundColor: colors.surface,
	}
}

function iconWellCss(look: SiteBannerLook, tone: SeverityTone) {
	const size =
		look === 'card' ? '3.25rem' : look === 'promo' ? '2.75rem' : '1.75rem'
	return {
		width: size,
		height: size,
		flex: '0 0 auto',
		display: 'grid',
		placeItems: 'center',
		borderRadius: look === 'strip' ? radius.md : radius.full,
		backgroundColor: tone.accent,
		color: colors.onPrimary,
		fontSize: look === 'strip' ? '0.85rem' : '1.05rem',
		lineHeight: 1,
	}
}

const dismissCss = {
	position: 'absolute' as const,
	top: '0.15rem',
	right: '0.15rem',
	width: '1.75rem',
	height: '1.75rem',
	border: 'none',
	borderRadius: radius.full,
	backgroundColor: 'transparent',
	color: colors.textMuted,
	fontSize: '1.25rem',
	lineHeight: 1,
	cursor: 'pointer',
	[hoverMq]: {
		'&:hover': {
			backgroundColor: colors.primarySoftest,
			color: colors.text,
		},
	},
}
