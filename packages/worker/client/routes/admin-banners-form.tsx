import { type Handle, type RemixNode, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { type createDoubleCheck } from '#client/double-check.ts'
import { SiteBannerEditor } from '#client/site-banner-editor.tsx'
import {
	siteBannerLooks,
	siteBannerPreviewLookParam,
} from '#universal/site-banners.ts'
import {
	descriptionCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { mq, spacing, typography } from '#universal/styles/tokens.ts'
import { AdminBannerTargetingCard } from './admin-banners-targeting.tsx'
import { lookLabel, type BannerDraft } from './admin-banners-shared.ts'

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
		children?: RemixNode
	}>,
) {
	const primaryButtonCss = getPillButtonCss({ size: 'sm' })
	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })

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
			children,
		} = handle.props
		const setDraft = (patch: Partial<BannerDraft>) => {
			onDraftChange({ ...draft, ...patch })
		}

		return (
			<form
				mix={[css({ display: 'grid', gap: spacing.lg }), on('submit', onSave)]}
			>
				<div
					mix={css({
						display: 'flex',
						flexWrap: 'wrap',
						justifyContent: 'space-between',
						gap: spacing.sm,
						alignItems: 'center',
					})}
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
					<div
						mix={css({
							display: 'flex',
							flexWrap: 'wrap',
							gap: spacing.sm,
							alignItems: 'center',
						})}
					>
						{siteBannerLooks.map((look) => (
							<button
								type="button"
								aria-pressed={draft.look === look}
								mix={[
									css(
										draft.look === look ? primaryButtonCss : secondaryButtonCss,
									),
									on('click', () => {
										setDraft({ look })
									}),
								]}
							>
								{lookLabel(look)}
							</button>
						))}
					</div>
				</div>
				<SiteBannerEditor draft={draft} onDraftChange={onDraftChange} />
				<p mix={css({ ...descriptionCss, margin: 0 })}>
					What visitors see. Click any text to edit. Homepage check:{' '}
					<code>
						?{siteBannerPreviewLookParam}={draft.look}
					</code>
				</p>
				<div
					mix={css({
						display: 'grid',
						gap: spacing.lg,
						gridTemplateColumns: 'minmax(16rem, 18rem) minmax(0, 1fr)',
						alignItems: 'start',
						[mq.tablet]: {
							gridTemplateColumns: 'minmax(0, 1fr)',
						},
					})}
				>
					{children}
					<AdminBannerTargetingCard
						draft={draft}
						updatedAt={updatedAt}
						isMutating={isMutating}
						actionState={actionState}
						deleteCheck={deleteCheck}
						onDraftChange={onDraftChange}
						onDelete={onDelete}
					/>
				</div>
			</form>
		)
	}
}
