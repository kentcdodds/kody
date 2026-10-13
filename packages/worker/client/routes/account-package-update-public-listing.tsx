import { type Handle, css } from 'remix/component'
import { on } from '#client/event-mixin.ts'
import { colors, radius, spacing } from '#universal/styles/tokens.ts'
import {
	getPillButtonCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import {
	type AccountPackageDetail,
	type AccountPackagesLoaderData,
} from '#universal/loader-data.ts'
import { updatePublicListingSectionId } from '#universal/update-public-listing.ts'

/**
 * Settings control to republish the public community listing pin to the
 * current published_commit. Separate confirm state from Turn off forkable.
 */
export function AccountPackageUpdatePublicListing(
	handle: Handle<{
		packageDetail: AccountPackageDetail
		onPackagesPayload: (payload: AccountPackagesLoaderData) => void
	}>,
) {
	let republishConfirmName = ''
	let republishState: 'idle' | 'submitting' | 'error' = 'idle'
	let republishMessage: string | null = null

	async function submitUpdatePublicListing(
		packageDetail: AccountPackageDetail,
	) {
		if (republishState === 'submitting') return
		if (republishConfirmName.trim() !== packageDetail.kodyId) {
			republishState = 'error'
			republishMessage = `Type ${packageDetail.kodyId} to update the public community listing to the current published commit.`
			handle.update()
			return
		}
		republishState = 'submitting'
		republishMessage = null
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
					action: 'set-visibility',
					packageId: packageDetail.id,
					visibility: 'public',
					confirmName: republishConfirmName.trim(),
				}),
			})
			const payload = (await response.json()) as AccountPackagesLoaderData & {
				error?: string
			}
			if (!response.ok || !payload?.ok) {
				throw new Error(
					payload?.error ?? 'Could not update the public community listing.',
				)
			}
			republishState = 'idle'
			republishConfirmName = ''
			handle.props.onPackagesPayload(payload)
			handle.update()
		} catch (error) {
			republishState = 'error'
			republishMessage =
				error instanceof Error
					? error.message
					: 'Could not update the public community listing.'
			handle.update()
		}
	}

	return () => {
		const { packageDetail } = handle.props
		if (!packageDetail.listingNeedsRepublish) return null

		return (
			<div
				id={updatePublicListingSectionId}
				mix={css({ display: 'grid', gap: spacing.xs })}
				data-testid="package-update-public-listing"
			>
				<p mix={css({ margin: 0, color: colors.textMuted })}>
					Publish and promote update the package runtime. The public community
					listing stays on its pinned snapshot until you republish it. Type the
					slug, then update the listing.
				</p>
				<label mix={css({ display: 'grid', gap: spacing.xs })}>
					<span mix={css(visuallyHiddenCss)}>
						Type {packageDetail.kodyId} to update the public listing
					</span>
					<input
						value={republishConfirmName}
						placeholder={packageDetail.kodyId}
						data-testid="package-update-public-listing-confirm"
						mix={[
							css({
								padding: spacing.sm,
								borderRadius: radius.md,
								border: `1px solid ${colors.border}`,
								backgroundColor: colors.surface,
								color: colors.text,
							}),
							on('input', (event) => {
								if (!(event.currentTarget instanceof HTMLInputElement)) {
									return
								}
								republishConfirmName = event.currentTarget.value
								handle.update()
							}),
						]}
					/>
				</label>
				<button
					type="button"
					disabled={republishState === 'submitting'}
					data-testid="package-update-public-listing-submit"
					mix={[
						css(getPillButtonCss()),
						on('click', () => void submitUpdatePublicListing(packageDetail)),
					]}
				>
					{republishState === 'submitting'
						? 'Updating listing…'
						: 'Update public listing'}
				</button>
				{republishMessage ? (
					<p mix={css({ margin: 0, color: colors.danger })} role="alert">
						{republishMessage}
					</p>
				) : null}
			</div>
		)
	}
}
