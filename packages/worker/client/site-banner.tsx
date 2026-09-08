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
	type SiteBannerLook,
	type SiteBannerView,
} from '#universal/site-banners.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	defaultSiteBannerIcon,
	siteBannerActionsCss,
	siteBannerBodyCss,
	siteBannerCopyCss,
	siteBannerDismissCss,
	siteBannerIconGlyph,
	siteBannerIconWellCss,
	siteBannerImageCss,
	siteBannerImagePixelSize,
	siteBannerInnerCss,
	siteBannerSeverityTone,
	siteBannerShellCss,
	siteBannerTitleCss,
} from './site-banner-looks.ts'

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
		const tone = siteBannerSeverityTone(banner.severity)

		return (
			<section
				data-testid={preview ? `site-banner-preview-${look}` : 'site-banner'}
				data-look={look}
				data-severity={banner.severity}
				aria-labelledby={titleId}
				mix={css(siteBannerShellCss(look, tone))}
			>
				<div mix={css(siteBannerInnerCss(look))}>
					{renderMedia(banner, look, tone)}
					<div mix={css(siteBannerCopyCss(look))}>
						<p id={titleId} mix={css(siteBannerTitleCss(look))}>
							{banner.title}
						</p>
						{banner.body ? (
							<p mix={css(siteBannerBodyCss(look))}>{banner.body}</p>
						) : null}
					</div>
					<div mix={css(siteBannerActionsCss(look))}>
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
							mix={[
								css(siteBannerDismissCss),
								on('click', () => onDismiss?.()),
							]}
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
	tone: ReturnType<typeof siteBannerSeverityTone>,
) {
	if (banner.imageUrl) {
		const size = siteBannerImagePixelSize(look)
		return (
			<img
				src={banner.imageUrl}
				alt=""
				width={size.width}
				height={size.height}
				mix={css(siteBannerImageCss(look))}
			/>
		)
	}
	return (
		<span aria-hidden="true" mix={css(siteBannerIconWellCss(look, tone))}>
			{siteBannerIconGlyph(banner.icon ?? defaultSiteBannerIcon(look))}
		</span>
	)
}
