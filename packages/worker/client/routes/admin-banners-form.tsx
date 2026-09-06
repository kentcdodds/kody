import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { type createDoubleCheck } from '#client/double-check.ts'
import { SiteBannerFrame } from '#client/site-banner.tsx'
import { formatNullableTimestamp } from '#client/format-timestamp.ts'
import { planNames } from '#universal/plans.ts'
import {
	siteBannerAudiences,
	siteBannerIcons,
	siteBannerLooks,
	siteBannerPageTargetings,
	siteBannerPreviewLookParam,
	siteBannerSeverities,
	type SiteBannerAudience,
	type SiteBannerIcon,
	type SiteBannerLook,
	type SiteBannerPageTargeting,
	type SiteBannerSeverity,
} from '#universal/site-banners.ts'
import {
	cardCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getDangerPillCss,
	getPillButtonCss,
	getSelectCss,
} from '#universal/styles/style-primitives.ts'
import { colors, mq, spacing, typography } from '#universal/styles/tokens.ts'
import {
	accountInputCss,
	accountTextareaCss,
} from './account-management-components.tsx'
import {
	audienceLabel,
	draftToPreview,
	lookLabel,
	type BannerDraft,
} from './admin-banners-shared.ts'

const selectCss = getSelectCss()

export function AdminBannerForm(
	handle: Handle<{
		draft: BannerDraft
		updatedAt: string | null
		isMutating: boolean
		actionState: 'idle' | 'saving' | 'deleting'
		deleteCheck: ReturnType<typeof createDoubleCheck>
		onDraftChange: (draft: BannerDraft) => void
		onSave: (event: SubmitEvent) => void
		onDelete: () => void
	}>,
) {
	const primaryButtonCss = getPillButtonCss({ size: 'sm' })
	const dangerButtonCss = getDangerPillCss({ size: 'sm' })

	return () => {
		const {
			draft,
			updatedAt,
			isMutating,
			actionState,
			deleteCheck,
			onDraftChange,
			onSave,
			onDelete,
		} = handle.props
		const setDraft = (patch: Partial<BannerDraft>) => {
			onDraftChange({ ...draft, ...patch })
		}

		return (
			<section mix={css({ display: 'grid', gap: spacing.lg })}>
				<form
					mix={[
						css({ ...cardCss, display: 'grid', gap: spacing.md }),
						on('submit', onSave),
					]}
				>
					<h2
						mix={css({
							margin: 0,
							fontSize: typography.fontSize.lg,
							fontWeight: typography.fontWeight.semibold,
						})}
					>
						{draft.id ? 'Edit banner' : 'New banner'}
					</h2>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Title</span>
						<input
							required
							maxLength={120}
							value={draft.title}
							mix={[
								css(accountInputCss),
								on('input', (event) => {
									if (!(event.currentTarget instanceof HTMLInputElement)) return
									setDraft({ title: event.currentTarget.value })
								}),
							]}
						/>
					</label>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Body</span>
						<textarea
							maxLength={400}
							value={draft.body}
							mix={[
								css({ ...accountTextareaCss, minHeight: '5rem' }),
								on('input', (event) => {
									if (!(event.currentTarget instanceof HTMLTextAreaElement))
										return
									setDraft({ body: event.currentTarget.value })
								}),
							]}
						/>
					</label>
					<div
						mix={css({
							display: 'grid',
							gap: spacing.md,
							gridTemplateColumns: '1fr 1fr',
							[mq.mobile]: { gridTemplateColumns: '1fr' },
						})}
					>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>CTA label</span>
							<input
								maxLength={40}
								value={draft.ctaLabel}
								mix={[
									css(accountInputCss),
									on('input', (event) => {
										if (!(event.currentTarget instanceof HTMLInputElement))
											return
										setDraft({ ctaLabel: event.currentTarget.value })
									}),
								]}
							/>
						</label>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>CTA URL</span>
							<input
								value={draft.ctaHref}
								placeholder="https://… or /path"
								mix={[
									css(accountInputCss),
									on('input', (event) => {
										if (!(event.currentTarget instanceof HTMLInputElement))
											return
										setDraft({ ctaHref: event.currentTarget.value })
									}),
								]}
							/>
						</label>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Secondary label</span>
							<input
								maxLength={40}
								value={draft.secondaryLabel}
								mix={[
									css(accountInputCss),
									on('input', (event) => {
										if (!(event.currentTarget instanceof HTMLInputElement))
											return
										setDraft({ secondaryLabel: event.currentTarget.value })
									}),
								]}
							/>
						</label>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Secondary URL</span>
							<input
								value={draft.secondaryHref}
								mix={[
									css(accountInputCss),
									on('input', (event) => {
										if (!(event.currentTarget instanceof HTMLInputElement))
											return
										setDraft({ secondaryHref: event.currentTarget.value })
									}),
								]}
							/>
						</label>
					</div>
					<div
						mix={css({
							display: 'grid',
							gap: spacing.md,
							gridTemplateColumns: '1fr 1fr',
						})}
					>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Look</span>
							<select
								value={draft.look}
								mix={[
									css(selectCss),
									on('change', (event) => {
										if (!(event.currentTarget instanceof HTMLSelectElement))
											return
										setDraft({
											look: event.currentTarget.value as SiteBannerLook,
										})
									}),
								]}
							>
								{siteBannerLooks.map((look) => (
									<option value={look}>{lookLabel(look)}</option>
								))}
							</select>
						</label>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Severity</span>
							<select
								value={draft.severity}
								mix={[
									css(selectCss),
									on('change', (event) => {
										if (!(event.currentTarget instanceof HTMLSelectElement))
											return
										setDraft({
											severity: event.currentTarget.value as SiteBannerSeverity,
										})
									}),
								]}
							>
								{siteBannerSeverities.map((severity) => (
									<option value={severity}>{severity}</option>
								))}
							</select>
						</label>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Icon</span>
							<select
								value={draft.icon}
								mix={[
									css(selectCss),
									on('change', (event) => {
										if (!(event.currentTarget instanceof HTMLSelectElement))
											return
										setDraft({
											icon: event.currentTarget.value as SiteBannerIcon | '',
										})
									}),
								]}
							>
								<option value="">None</option>
								{siteBannerIcons.map((icon) => (
									<option value={icon}>{icon}</option>
								))}
							</select>
						</label>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Priority</span>
							<input
								type="number"
								min="0"
								max="1000"
								value={draft.priority}
								mix={[
									css(accountInputCss),
									on('input', (event) => {
										if (!(event.currentTarget instanceof HTMLInputElement))
											return
										setDraft({ priority: event.currentTarget.value })
									}),
								]}
							/>
						</label>
					</div>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Image URL (optional)</span>
						<input
							value={draft.imageUrl}
							placeholder="https://…"
							mix={[
								css(accountInputCss),
								on('input', (event) => {
									if (!(event.currentTarget instanceof HTMLInputElement)) return
									setDraft({ imageUrl: event.currentTarget.value })
								}),
							]}
						/>
					</label>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Page targeting</span>
						<select
							value={draft.pageTargeting}
							mix={[
								css(selectCss),
								on('change', (event) => {
									if (!(event.currentTarget instanceof HTMLSelectElement))
										return
									setDraft({
										pageTargeting: event.currentTarget
											.value as SiteBannerPageTargeting,
									})
								}),
							]}
						>
							{siteBannerPageTargetings.map((targeting) => (
								<option value={targeting}>
									{targeting === 'all' ? 'All pages' : 'Route patterns'}
								</option>
							))}
						</select>
					</label>
					{draft.pageTargeting === 'routes' ? (
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>
								Route patterns (one per line)
							</span>
							<textarea
								value={draft.routePatterns}
								placeholder={'/blog\n/pricing\n/account/**'}
								mix={[
									css({ ...accountTextareaCss, minHeight: '4.5rem' }),
									on('input', (event) => {
										if (!(event.currentTarget instanceof HTMLTextAreaElement))
											return
										setDraft({ routePatterns: event.currentTarget.value })
									}),
								]}
							/>
						</label>
					) : null}
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Audience</span>
						<select
							value={draft.audience}
							mix={[
								css(selectCss),
								on('change', (event) => {
									if (!(event.currentTarget instanceof HTMLSelectElement))
										return
									setDraft({
										audience: event.currentTarget.value as SiteBannerAudience,
									})
								}),
							]}
						>
							{siteBannerAudiences.map((audience) => (
								<option value={audience}>{audienceLabel(audience)}</option>
							))}
						</select>
					</label>
					{draft.audience === 'users' ? (
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Stable user ids</span>
							<textarea
								value={draft.audienceUserIds}
								mix={[
									css({ ...accountTextareaCss, minHeight: '4.5rem' }),
									on('input', (event) => {
										if (!(event.currentTarget instanceof HTMLTextAreaElement))
											return
										setDraft({ audienceUserIds: event.currentTarget.value })
									}),
								]}
							/>
						</label>
					) : null}
					{draft.audience === 'plans' ? (
						<fieldset
							mix={css({
								border: `1px solid ${colors.border}`,
								borderRadius: '0.75rem',
								margin: 0,
								padding: spacing.md,
								display: 'grid',
								gap: spacing.sm,
							})}
						>
							<legend mix={css(fieldLabelCss)}>Plans</legend>
							{planNames.map((plan) => (
								<label
									mix={css({
										display: 'flex',
										gap: spacing.sm,
										alignItems: 'center',
									})}
								>
									<input
										type="checkbox"
										checked={draft.audiencePlans.includes(plan)}
										mix={on('change', () => {
											setDraft({
												audiencePlans: draft.audiencePlans.includes(plan)
													? draft.audiencePlans.filter((item) => item !== plan)
													: [...draft.audiencePlans, plan],
											})
										})}
									/>
									{plan}
								</label>
							))}
						</fieldset>
					) : null}
					<div
						mix={css({
							display: 'grid',
							gap: spacing.md,
							gridTemplateColumns: '1fr 1fr',
						})}
					>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Starts at (ISO, optional)</span>
							<input
								value={draft.startsAt}
								placeholder="2026-09-10T15:00:00.000Z"
								mix={[
									css(accountInputCss),
									on('input', (event) => {
										if (!(event.currentTarget instanceof HTMLInputElement))
											return
										setDraft({ startsAt: event.currentTarget.value })
									}),
								]}
							/>
						</label>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Ends at (ISO, optional)</span>
							<input
								value={draft.endsAt}
								mix={[
									css(accountInputCss),
									on('input', (event) => {
										if (!(event.currentTarget instanceof HTMLInputElement))
											return
										setDraft({ endsAt: event.currentTarget.value })
									}),
								]}
							/>
						</label>
					</div>
					<label
						mix={css({
							display: 'flex',
							gap: spacing.sm,
							alignItems: 'center',
						})}
					>
						<input
							type="checkbox"
							checked={draft.enabled}
							mix={on('change', () => {
								setDraft({ enabled: !draft.enabled })
							})}
						/>
						Enabled
					</label>
					<label
						mix={css({
							display: 'flex',
							gap: spacing.sm,
							alignItems: 'center',
						})}
					>
						<input
							type="checkbox"
							checked={draft.dismissible}
							mix={on('change', () => {
								setDraft({ dismissible: !draft.dismissible })
							})}
						/>
						Users can dismiss forever
					</label>
					{draft.id ? (
						<p mix={css({ ...descriptionCss, margin: 0 })}>
							Updated {formatNullableTimestamp(updatedAt)}
						</p>
					) : null}
					<div
						mix={css({
							display: 'flex',
							flexWrap: 'wrap',
							gap: spacing.sm,
						})}
					>
						<button
							type="submit"
							disabled={isMutating}
							mix={css(primaryButtonCss)}
						>
							{actionState === 'saving' ? 'Saving…' : 'Save banner'}
						</button>
						{draft.id ? (
							<button
								type="button"
								disabled={isMutating}
								mix={[
									css(dangerButtonCss),
									...deleteCheck.getButtonMix({
										on: { click: onDelete },
									}),
								]}
							>
								{deleteCheck.doubleCheck
									? 'Click again to delete'
									: actionState === 'deleting'
										? 'Deleting…'
										: 'Delete'}
							</button>
						) : null}
					</div>
				</form>
				<section mix={css({ display: 'grid', gap: spacing.md })}>
					<h2
						mix={css({
							margin: 0,
							fontSize: typography.fontSize.lg,
							fontWeight: typography.fontWeight.semibold,
						})}
					>
						Look spike
					</h2>
					<p mix={css({ ...descriptionCss, margin: 0 })}>
						Three launch-video treatments using this draft. Open the homepage as
						an admin with{' '}
						<code>?{siteBannerPreviewLookParam}=strip|promo|card</code> to
						preview on a live page without enabling a banner.
					</p>
					{siteBannerLooks.map((look) => (
						<div key={look} mix={css({ display: 'grid', gap: spacing.sm })}>
							<h3
								mix={css({
									margin: 0,
									fontSize: typography.fontSize.sm,
									fontWeight: typography.fontWeight.semibold,
								})}
							>
								{lookLabel(look)}
							</h3>
							<SiteBannerFrame banner={draftToPreview(draft, look)} preview />
						</div>
					))}
				</section>
			</section>
		)
	}
}
