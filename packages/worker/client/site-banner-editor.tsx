import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { type BannerDraft } from '#client/routes/admin-banners-shared.ts'
import {
	resolveSiteBannerImageUrl,
	rewriteBannerHrefForYoutubeWatch,
} from '#universal/youtube-watch.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
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
	siteBannerStackMq,
	siteBannerTitleCss,
} from './site-banner-looks.ts'

export function SiteBannerEditor(
	handle: Handle<{
		draft: BannerDraft
		onDraftChange: (draft: BannerDraft) => void
	}>,
) {
	const ctaButtonCss = getPillButtonCss({ size: 'sm' })
	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })

	return () => {
		const { draft, onDraftChange } = handle.props
		const look = draft.look
		const tone = siteBannerSeverityTone(draft.severity)
		const imageUrl = resolveSiteBannerImageUrl({
			imageUrl: draft.imageUrl.trim() || null,
			ctaHref: draft.ctaHref.trim() || null,
			secondaryHref: draft.secondaryHref.trim() || null,
		})
		const ctaHref = rewriteBannerHrefForYoutubeWatch(
			draft.ctaHref.trim() || null,
		)
		const setDraft = (patch: Partial<BannerDraft>) => {
			onDraftChange({ ...draft, ...patch })
		}

		return (
			<section
				data-testid={`site-banner-preview-${look}`}
				data-look={look}
				data-severity={draft.severity}
				aria-label="Editable banner preview"
				mix={css(siteBannerShellCss(look, tone))}
			>
				<div mix={css(siteBannerInnerCss(look))}>
					{imageUrl ? (
						<img
							src={imageUrl}
							alt=""
							width={siteBannerImagePixelSize(look).width}
							height={siteBannerImagePixelSize(look).height}
							mix={css(siteBannerImageCss(look))}
						/>
					) : (
						<span
							aria-hidden="true"
							mix={css(siteBannerIconWellCss(look, tone))}
						>
							{siteBannerIconGlyph(draft.icon || defaultSiteBannerIcon(look))}
						</span>
					)}
					<div mix={css(siteBannerCopyCss(look))}>
						<label mix={css({ display: 'block', minWidth: 0 })}>
							<span mix={css(visuallyHiddenCss)}>Title</span>
							<input
								required
								maxLength={120}
								value={draft.title}
								placeholder="Banner title"
								mix={[
									css(editableTextCss(siteBannerTitleCss(look))),
									on('input', (event) => {
										if (!(event.currentTarget instanceof HTMLInputElement))
											return
										setDraft({ title: event.currentTarget.value })
									}),
								]}
							/>
						</label>
						<label mix={css({ display: 'block', minWidth: 0 })}>
							<span mix={css(visuallyHiddenCss)}>Body</span>
							<textarea
								maxLength={400}
								value={draft.body}
								placeholder="Optional body"
								rows={look === 'strip' ? 1 : 2}
								mix={[
									css({
										...editableTextCss(siteBannerBodyCss(look)),
										resize: 'none',
										display: 'block',
										minHeight: look === 'strip' ? '1.25rem' : '2.5rem',
										// Live strip hides body under 720px. Keep the field
										// visible here so operators can still edit it.
										[siteBannerStackMq]: {
											display: 'block',
										},
									}),
									on('input', (event) => {
										if (!(event.currentTarget instanceof HTMLTextAreaElement))
											return
										setDraft({ body: event.currentTarget.value })
									}),
								]}
							/>
						</label>
					</div>
					<div mix={css(siteBannerActionsCss(look))}>
						<div mix={css(actionFieldCss)}>
							<label>
								<span mix={css(visuallyHiddenCss)}>CTA label</span>
								<input
									maxLength={40}
									value={draft.ctaLabel}
									placeholder="Watch"
									mix={[
										css(editableButtonCss(ctaButtonCss)),
										on('input', (event) => {
											if (!(event.currentTarget instanceof HTMLInputElement))
												return
											setDraft({ ctaLabel: event.currentTarget.value })
										}),
									]}
								/>
							</label>
							<label>
								<span mix={css(visuallyHiddenCss)}>CTA URL</span>
								<input
									value={draft.ctaHref}
									placeholder={ctaHref ?? '/?youtubeId=… or /path'}
									mix={[
										css(hrefInputCss),
										on('input', (event) => {
											if (!(event.currentTarget instanceof HTMLInputElement))
												return
											setDraft({ ctaHref: event.currentTarget.value })
										}),
									]}
								/>
							</label>
						</div>
						<div mix={css(actionFieldCss)}>
							<label>
								<span mix={css(visuallyHiddenCss)}>Secondary label</span>
								<input
									maxLength={40}
									value={draft.secondaryLabel}
									placeholder="Optional"
									mix={[
										css(editableButtonCss(secondaryButtonCss)),
										on('input', (event) => {
											if (!(event.currentTarget instanceof HTMLInputElement))
												return
											setDraft({ secondaryLabel: event.currentTarget.value })
										}),
									]}
								/>
							</label>
							<label>
								<span mix={css(visuallyHiddenCss)}>Secondary URL</span>
								<input
									value={draft.secondaryHref}
									placeholder="/blog"
									mix={[
										css(hrefInputCss),
										on('input', (event) => {
											if (!(event.currentTarget instanceof HTMLInputElement))
												return
											setDraft({ secondaryHref: event.currentTarget.value })
										}),
									]}
								/>
							</label>
						</div>
					</div>
					<button
						type="button"
						aria-pressed={draft.dismissible}
						aria-label={
							draft.dismissible
								? 'Dismissible. Click to require the banner.'
								: 'Not dismissible. Click to allow dismiss.'
						}
						title={
							draft.dismissible
								? 'Dismissible — click to lock'
								: 'Locked — click to allow dismiss'
						}
						mix={[
							css({
								...siteBannerDismissCss,
								opacity: draft.dismissible ? 1 : 0.35,
							}),
							on('click', () => {
								setDraft({ dismissible: !draft.dismissible })
							}),
						]}
					>
						×
					</button>
				</div>
			</section>
		)
	}
}

function editableTextCss(base: Record<string, unknown>) {
	return {
		...base,
		width: '100%',
		display: 'block',
		boxSizing: 'border-box' as const,
		border: `1px dashed color-mix(in srgb, ${colors.border} 70%, transparent)`,
		borderRadius: radius.sm,
		backgroundColor: 'transparent',
		paddingBlock: '0.1rem',
		paddingInline: '0.2rem',
		appearance: 'none',
		'&:focus': {
			outline: `2px solid ${colors.primary}`,
			outlineOffset: '1px',
			borderColor: 'transparent',
		},
		'&::placeholder': {
			color: colors.textMuted,
			opacity: 0.72,
		},
	}
}

function editableButtonCss(base: Record<string, unknown>) {
	return {
		...base,
		cursor: 'text',
		minWidth: '7.5rem',
		maxWidth: '14rem',
		textAlign: 'center' as const,
		appearance: 'none',
		'&:hover': {
			transform: 'none',
		},
		'&:focus': {
			outline: `2px solid ${colors.onPrimary}`,
			outlineOffset: '2px',
		},
		'&::placeholder': {
			color: 'inherit',
			opacity: 0.62,
		},
	}
}

const actionFieldCss = {
	display: 'grid',
	gap: '0.3rem',
	minWidth: 0,
}

const hrefInputCss = {
	width: '100%',
	minWidth: '7.5rem',
	boxSizing: 'border-box' as const,
	border: `1px dashed ${colors.border}`,
	borderRadius: radius.sm,
	backgroundColor: 'transparent',
	color: colors.textMuted,
	fontFamily: typography.fontFamily,
	fontSize: typography.fontSize.xs,
	paddingBlock: '0.2rem',
	paddingInline: spacing.sm,
	appearance: 'none',
	'&:focus': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '1px',
	},
	'&::placeholder': {
		color: colors.textMuted,
		opacity: 0.7,
	},
}
