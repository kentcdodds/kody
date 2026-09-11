import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { accountInputCss } from '#client/routes/account-management-components.tsx'
import { type BannerDraft } from '#client/routes/admin-banners-shared.ts'
import { renderIcon } from '#universal/icon.tsx'
import { resolveSiteBannerImageUrl } from '#universal/youtube-watch.ts'
import {
	fieldLabelCss,
	getGhostButtonCss,
	getPillButtonCss,
	hoverMq,
	mergeCss,
	pageGutter,
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
	siteBannerIconName,
	siteBannerIconWellCss,
	siteBannerImageCss,
	siteBannerImagePixelSize,
	siteBannerInnerCss,
	siteBannerSeverityTone,
	siteBannerShellCss,
	siteBannerStackMq,
	siteBannerStageContainerName,
	siteBannerStageStackAt,
	siteBannerTitleCss,
} from './site-banner-looks.ts'

export function SiteBannerEditor(
	handle: Handle<{
		draft: BannerDraft
		onDraftChange: (draft: BannerDraft) => void
	}>,
) {
	const filledCtaCss = mergeCss(getPillButtonCss({ size: 'sm' }), {
		...pillInputResetCss,
		[hoverMq]: {
			'&:not(:disabled):hover': {
				transform: 'none',
				boxShadow: 'none',
				backgroundColor: colors.primary,
			},
		},
	})
	const emptyCtaCss = mergeCss(getPillButtonCss({ size: 'sm' }), {
		...pillInputResetCss,
		backgroundColor: 'transparent',
		color: colors.primaryText,
		border: `1.5px dashed ${colors.primary}`,
		boxShadow: 'none',
		[hoverMq]: {
			'&:not(:disabled):hover': {
				transform: 'none',
				boxShadow: 'none',
				backgroundColor: 'transparent',
			},
		},
		'&::placeholder': {
			color: colors.primaryText,
			opacity: 0.8,
		},
	})
	const filledSecondaryCss = mergeCss(getGhostButtonCss({ size: 'sm' }), {
		...pillInputResetCss,
		[hoverMq]: {
			'&:not(:disabled):hover': {
				transform: 'none',
				boxShadow: `inset 0 0 0 1.5px ${colors.border}`,
				backgroundColor: 'transparent',
			},
		},
	})
	const emptySecondaryCss = mergeCss(getGhostButtonCss({ size: 'sm' }), {
		...pillInputResetCss,
		backgroundColor: 'transparent',
		color: colors.textMuted,
		opacity: 0.7,
		border: `1.5px dashed ${colors.border}`,
		boxShadow: 'none',
		[hoverMq]: {
			'&:not(:disabled):hover': {
				transform: 'none',
				boxShadow: 'none',
				backgroundColor: 'transparent',
				opacity: 1,
			},
		},
		'&::placeholder': {
			color: colors.textMuted,
			opacity: 1,
		},
	})

	return () => {
		const { draft, onDraftChange } = handle.props
		const look = draft.look
		const tone = siteBannerSeverityTone(draft.severity)
		const imageUrl = resolveSiteBannerImageUrl({
			imageUrl: draft.imageUrl.trim() || null,
			ctaHref: draft.ctaHref.trim() || null,
			secondaryHref: draft.secondaryHref.trim() || null,
		})
		const showSecondary =
			Boolean(draft.ctaLabel) ||
			Boolean(draft.secondaryLabel) ||
			Boolean(draft.secondaryHref)
		const setDraft = (patch: Partial<BannerDraft>) => {
			onDraftChange({ ...draft, ...patch })
		}

		return (
			<div
				mix={css({
					border: `1px solid ${colors.border}`,
					borderRadius: radius.lg,
					overflow: 'hidden',
					backgroundColor: colors.surface,
					containerType: 'inline-size',
					containerName: siteBannerStageContainerName,
				})}
			>
				<section
					data-testid={`site-banner-preview-${look}`}
					data-look={look}
					data-severity={draft.severity}
					aria-label="Editable banner preview"
					mix={css({
						...siteBannerShellCss(look, tone),
						...(look === 'card' ? {} : { borderBottom: 'none' }),
					})}
				>
					<div
						mix={css(
							mergeCss(siteBannerInnerCss(look), {
								[siteBannerStageStackAt]: {
									flexWrap: 'wrap',
									alignItems: 'flex-start',
									gap: look === 'strip' ? spacing.sm : spacing.md,
									paddingInlineEnd: look === 'card' ? '2rem' : '1.75rem',
								},
							}),
						)}
					>
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
								{renderIcon(
									siteBannerIconName(draft.icon || defaultSiteBannerIcon(look)),
								)}
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
										css(editableCopyCss(siteBannerTitleCss(look))),
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
											...editableCopyCss(siteBannerBodyCss(look)),
											resize: 'none',
											fieldSizing: 'content',
											maxHeight: '8.4rem',
											overflowY: 'auto',
											minHeight: look === 'strip' ? '1.25rem' : '2.5rem',
											[siteBannerStackMq]: {
												display: 'block',
											},
											[siteBannerStageStackAt]: {
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
						<div
							mix={css(
								mergeCss(siteBannerActionsCss(look), {
									[siteBannerStageStackAt]: {
										width: '100%',
									},
								}),
							)}
						>
							<label>
								<span mix={css(visuallyHiddenCss)}>CTA label</span>
								<input
									maxLength={40}
									value={draft.ctaLabel}
									placeholder="Button label"
									size={pillSize(draft.ctaLabel, 'Button label')}
									mix={[
										css(draft.ctaLabel.trim() ? filledCtaCss : emptyCtaCss),
										on('input', (event) => {
											if (!(event.currentTarget instanceof HTMLInputElement))
												return
											setDraft({ ctaLabel: event.currentTarget.value })
										}),
									]}
								/>
							</label>
							{showSecondary ? (
								<label>
									<span mix={css(visuallyHiddenCss)}>Secondary label</span>
									<input
										maxLength={40}
										value={draft.secondaryLabel}
										placeholder="Second button"
										size={pillSize(draft.secondaryLabel, 'Second button')}
										mix={[
											css(
												draft.secondaryLabel.trim()
													? filledSecondaryCss
													: emptySecondaryCss,
											),
											on('input', (event) => {
												if (!(event.currentTarget instanceof HTMLInputElement))
													return
												setDraft({
													secondaryLabel: event.currentTarget.value,
												})
											}),
										]}
									/>
								</label>
							) : null}
						</div>
						{draft.dismissible ? (
							<span
								aria-hidden="true"
								mix={css({
									...siteBannerDismissCss,
									cursor: 'default',
									pointerEvents: 'none',
								})}
							>
								×
							</span>
						) : null}
					</div>
				</section>
				<div
					mix={css({
						display: 'grid',
						gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr) auto',
						gap: spacing.md,
						alignItems: 'end',
						padding: `${spacing.sm} ${pageGutter} ${spacing.md}`,
						backgroundColor: colors.surface,
						borderTop: `1px solid ${colors.border}`,
						[siteBannerStageStackAt]: {
							gridTemplateColumns: '1fr',
						},
					})}
				>
					<label mix={css(railFieldCss)}>
						<span
							mix={css({
								...fieldLabelCss,
								fontSize: typography.fontSize.xs,
								color: colors.textMuted,
							})}
						>
							CTA URL
						</span>
						<input
							value={draft.ctaHref}
							placeholder="/?youtubeId=… or https://…"
							mix={[
								css(railInputCss),
								on('input', (event) => {
									if (!(event.currentTarget instanceof HTMLInputElement)) return
									setDraft({ ctaHref: event.currentTarget.value })
								}),
							]}
						/>
						{draft.ctaLabel.trim() && !draft.ctaHref.trim() ? (
							<span mix={css(railHintCss)}>
								Add a URL or the button won't show.
							</span>
						) : null}
						{draft.ctaHref.trim() && !draft.ctaLabel.trim() ? (
							<span mix={css(railHintCss)}>
								Add a label or the button won't show.
							</span>
						) : null}
					</label>
					<label mix={css(railFieldCss)}>
						<span
							mix={css({
								...fieldLabelCss,
								fontSize: typography.fontSize.xs,
								color: colors.textMuted,
							})}
						>
							Secondary URL
						</span>
						<input
							value={draft.secondaryHref}
							placeholder="/blog"
							mix={[
								css(railInputCss),
								on('input', (event) => {
									if (!(event.currentTarget instanceof HTMLInputElement)) return
									setDraft({ secondaryHref: event.currentTarget.value })
								}),
							]}
						/>
						{draft.secondaryLabel.trim() && !draft.secondaryHref.trim() ? (
							<span mix={css(railHintCss)}>
								Add a URL or the button won't show.
							</span>
						) : null}
						{draft.secondaryHref.trim() && !draft.secondaryLabel.trim() ? (
							<span mix={css(railHintCss)}>
								Add a label or the button won't show.
							</span>
						) : null}
					</label>
					<label
						mix={css({
							display: 'flex',
							gap: spacing.sm,
							alignItems: 'center',
							alignSelf: 'end',
							justifySelf: 'end',
							paddingBottom: '0.55rem',
							[siteBannerStageStackAt]: {
								justifySelf: 'start',
								paddingBottom: 0,
							},
						})}
					>
						<input
							type="checkbox"
							checked={draft.dismissible}
							mix={on('change', () => {
								setDraft({ dismissible: !draft.dismissible })
							})}
						/>
						Dismissible
					</label>
				</div>
			</div>
		)
	}
}

function pillSize(value: string, placeholder: string) {
	return Math.min(24, Math.max(6, (value || placeholder).length))
}

function editableCopyCss(base: Record<string, unknown>) {
	return {
		...base,
		width: 'calc(100% + 0.7rem)',
		display: 'block',
		boxSizing: 'border-box' as const,
		border: 'none',
		borderRadius: radius.sm,
		backgroundColor: 'transparent',
		paddingBlock: '0.1rem',
		paddingInline: '0.35rem',
		marginInline: '-0.35rem',
		appearance: 'none',
		[hoverMq]: {
			'&:hover': {
				backgroundColor: `color-mix(in srgb, ${colors.surface} 55%, transparent)`,
			},
		},
		'&:focus': {
			outline: `2px solid ${colors.primary}`,
			outlineOffset: '1px',
		},
		'&::placeholder': {
			color: colors.textMuted,
			opacity: 1,
		},
	}
}

const pillInputResetCss = {
	cursor: 'text',
	minWidth: '6.5rem',
	maxWidth: '14rem',
	textAlign: 'center' as const,
	appearance: 'none',
	fieldSizing: 'content',
	'&:focus': {
		outline: 'none',
		boxShadow: `0 0 0 2px ${colors.surface}, 0 0 0 4px ${colors.primary}`,
	},
}

const railFieldCss = {
	display: 'grid',
	gap: '0.3rem',
	minWidth: 0,
}

const railInputCss = {
	...accountInputCss,
	paddingBlock: '0.4rem',
	fontSize: typography.fontSize.sm,
	fontFamily: typography.fontFamilyMono,
}

const railHintCss = {
	color: colors.textMuted,
	fontSize: typography.fontSize.xs,
}
