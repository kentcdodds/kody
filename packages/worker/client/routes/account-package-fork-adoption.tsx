import { css, type Handle } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { formatTimestampDate } from '#client/format-timestamp.ts'
import {
	communityForkAdoptionReviewNoteMinLength,
	communityForkAdoptionSectionId,
} from '#universal/community-fork-adoption.ts'
import {
	type AccountPackageCommunityFork,
	type AccountPackageDetail,
	type AccountPackagesLoaderData,
} from '#universal/loader-data.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	getAccentCalloutCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountTextareaCss,
} from './account-management-components.tsx'

export function AccountPackageForkAdoption(
	handle: Handle<{
		packageDetail: AccountPackageDetail
		communityFork: AccountPackageCommunityFork
		onPackagesPayload: (payload: AccountPackagesLoaderData) => void
	}>,
) {
	let reviewNote = ''
	let submitting = false
	let error: string | null = null

	async function submitAdoption(event: SubmitEvent) {
		event.preventDefault()
		if (submitting) return
		submitting = true
		error = null
		handle.update()
		try {
			const response = await fetch('/account/packages.json', {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'adopt-community-fork',
					packageId: handle.props.packageDetail.id,
					reviewNote: reviewNote.trim(),
				}),
			})
			const payload = (await response.json().catch(() => null)) as
				| (AccountPackagesLoaderData & { error?: string })
				| null
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error ?? 'Could not adopt this fork.')
			}
			reviewNote = ''
			submitting = false
			handle.props.onPackagesPayload(payload)
			handle.update()
		} catch (caught) {
			submitting = false
			error =
				caught instanceof Error ? caught.message : 'Could not adopt this fork.'
			handle.update()
		}
	}

	return () => {
		const { communityFork } = handle.props
		const upstream = communityFork.listingName ?? 'a community listing'

		return (
			<section
				id={communityForkAdoptionSectionId}
				aria-labelledby="community-fork-adoption-title"
				data-testid="community-fork-adoption"
				data-adopted={communityFork.adoptedAt ? 'true' : 'false'}
				mix={css({ display: 'grid', gap: spacing.sm })}
			>
				<h3 id="community-fork-adoption-title" mix={css(headingCss)}>
					Community fork
				</h3>
				{communityFork.adoptedAt ? (
					<div mix={css(getAccentCalloutCss())}>
						<p mix={css({ margin: 0 })}>
							Adopted {formatTimestampDate(communityFork.adoptedAt)}. This fork
							of {upstream} can read and use your user secrets like a package
							you wrote.
						</p>
						{communityFork.adoptionNote ? (
							<p mix={css(accountFieldNoteCss)}>
								Review note: {communityFork.adoptionNote}
							</p>
						) : null}
					</div>
				) : (
					<form
						mix={[
							css({ display: 'grid', gap: spacing.sm }),
							on('submit', submitAdoption),
						]}
					>
						<p mix={css(accountFieldNoteCss)}>
							This package is a fork of {upstream}. Until you adopt it, it can
							only read user secrets you allow one at a time. Adopting lets it
							read and use your user secrets like a package you wrote. Review
							the source first. Agents cannot adopt for you.
						</p>
						<label mix={css(accountFieldCss)}>
							<span mix={css(accountFieldLabelCss)}>What you reviewed</span>
							<textarea
								name="reviewNote"
								data-testid="community-fork-adoption-note"
								data-field-ring
								required
								minLength={communityForkAdoptionReviewNoteMinLength}
								placeholder="Which files you read and why you trust this fork."
								value={reviewNote}
								mix={[
									css(accountTextareaCss),
									on('input', (event) => {
										if (!(event.currentTarget instanceof HTMLTextAreaElement)) {
											return
										}
										reviewNote = event.currentTarget.value
										handle.update()
									}),
								]}
							/>
						</label>
						{error ? (
							<p role="alert" mix={css(errorTextCss)}>
								{error}
							</p>
						) : null}
						<div mix={css(accountActionsCss)}>
							<button
								type="submit"
								data-testid="community-fork-adopt"
								disabled={
									submitting ||
									reviewNote.trim().length <
										communityForkAdoptionReviewNoteMinLength
								}
								mix={css(getPillButtonCss({ size: 'sm' }))}
							>
								{submitting ? 'Adopting…' : 'Adopt fork'}
							</button>
						</div>
					</form>
				)}
			</section>
		)
	}
}

const headingCss = {
	margin: 0,
	fontSize: typography.fontSize.base,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
}

const errorTextCss = {
	margin: 0,
	color: colors.error,
	fontSize: typography.fontSize.sm,
}
