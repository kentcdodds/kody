import { type Handle, css } from 'remix/component'
import { buildPackageAppPath } from '@kody-internal/shared/public-urls.ts'
import { routes } from '#universal/routes.ts'
import { formatTimestampDate } from '#client/format-timestamp.ts'
import { on } from '#client/event-mixin.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	ForkAheadLink,
	ForkOutdatedCopyButton,
} from '#universal/fork-outdated-copy-button.tsx'
import { renderIcon } from '#universal/icon.tsx'
import {
	getGhostButtonCss,
	getPillButtonCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import {
	accountDisclosureCss,
	IdValue,
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'
import { RecordChips, recordBodyCss } from './record-table.tsx'
import { AccountPackageDeleteDialog } from './account-package-delete-dialog.tsx'
import { AccountPackageForkAdoption } from './account-package-fork-adoption.tsx'
import { renderPackagePublishingPanel } from './account-package-publishing-panel.tsx'
import {
	type AccountPackageDetail,
	type AccountPackagesLoaderData,
} from '#universal/loader-data.ts'

function isPackageLocked(lockedAt: string | null | undefined) {
	return typeof lockedAt === 'string' && lockedAt.trim().length > 0
}

export function AccountPackageOwnerDetails(
	handle: Handle<{
		ownerUsername: string
		packageDetail: AccountPackageDetail
		lockInFlight: boolean
		viewerCanPublish: boolean
		viewerCanDelete: boolean
		viewerCanAdoptCommunityFork: boolean
		onToggleLock: () => void
		onPackagesPayload: (payload: AccountPackagesLoaderData) => void
	}>,
) {
	let confirmName = ''
	let internetVisibleConfirmName = ''
	let visibilityState: 'idle' | 'submitting' | 'error' = 'idle'
	let visibilityMessage: string | null = null
	let internetVisibleState: 'idle' | 'submitting' | 'error' = 'idle'
	let internetVisibleMessage: string | null = null
	let internetVisibleApprovalUrl: string | null = null

	async function submitVisibility(
		packageDetail: AccountPackageDetail,
		visibility: 'public' | 'private',
	) {
		if (visibilityState === 'submitting') return
		if (confirmName.trim() !== packageDetail.kodyId) {
			visibilityState = 'error'
			visibilityMessage =
				visibility === 'public'
					? `Type ${packageDetail.kodyId} to make this package forkable. Anyone will be able to read and fork the default branch on /community.`
					: `Type ${packageDetail.kodyId} to turn off forkable. Public URLs will 404; existing forks keep their copies.`
			handle.update()
			return
		}
		visibilityState = 'submitting'
		visibilityMessage = null
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
					visibility,
					confirmName: confirmName.trim(),
				}),
			})
			const payload = (await response.json()) as AccountPackagesLoaderData & {
				error?: string
			}
			if (!response.ok || !payload?.ok) {
				throw new Error(
					payload?.error ?? 'Could not update package visibility.',
				)
			}
			visibilityState = 'idle'
			confirmName = ''
			handle.props.onPackagesPayload(payload)
			handle.update()
		} catch (error) {
			visibilityState = 'error'
			visibilityMessage =
				error instanceof Error
					? error.message
					: 'Could not update package visibility.'
			handle.update()
		}
	}

	async function submitInternetVisible(
		packageDetail: AccountPackageDetail,
		internetVisible: boolean,
	) {
		if (internetVisibleState === 'submitting') return
		if (internetVisibleConfirmName.trim() !== packageDetail.kodyId) {
			internetVisibleState = 'error'
			internetVisibleApprovalUrl = null
			internetVisibleMessage = internetVisible
				? `Type ${packageDetail.kodyId} to continue. You will review credentials before the app is served publicly.`
				: `Type ${packageDetail.kodyId} to turn off internet-visible serving.`
			handle.update()
			return
		}
		internetVisibleState = 'submitting'
		internetVisibleMessage = null
		internetVisibleApprovalUrl = null
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
					action: 'set-internet-visible',
					packageId: packageDetail.id,
					internetVisible,
					confirmName: internetVisibleConfirmName.trim(),
				}),
			})
			const payload = (await response.json()) as AccountPackagesLoaderData & {
				error?: string
				approvalUrl?: string
			}
			if (!response.ok || !payload?.ok) {
				if (typeof payload?.approvalUrl === 'string' && payload.approvalUrl) {
					internetVisibleApprovalUrl = payload.approvalUrl
				}
				throw new Error(
					payload?.error ?? 'Could not update internet-visible setting.',
				)
			}
			internetVisibleState = 'idle'
			internetVisibleConfirmName = ''
			handle.props.onPackagesPayload(payload)
			handle.update()
		} catch (error) {
			internetVisibleState = 'error'
			internetVisibleMessage =
				error instanceof Error
					? error.message
					: 'Could not update internet-visible setting.'
			handle.update()
		}
	}

	return () => {
		const {
			packageDetail,
			lockInFlight,
			onToggleLock,
			viewerCanPublish,
			viewerCanDelete,
			viewerCanAdoptCommunityFork,
		} = handle.props

		return (
			<div mix={css(recordBodyCss)} data-testid="package-owner-details">
				<div mix={css({ display: 'grid', gap: spacing.xs })}>
					<div
						mix={css({
							display: 'flex',
							alignItems: 'center',
							gap: spacing.xs,
							flexWrap: 'wrap',
							minWidth: 0,
						})}
					>
						<h2
							mix={css({
								margin: 0,
								fontSize: typography.fontSize.lg,
								fontWeight: typography.fontWeight.semibold,
								color: colors.text,
								overflowWrap: 'anywhere',
							})}
						>
							{packageDetail.name}
						</h2>
						<button
							type="button"
							disabled={lockInFlight}
							title={
								isPackageLocked(packageDetail.lockedAt)
									? 'Unlock publishes'
									: 'Lock publishes'
							}
							data-testid="account-package-lock-toggle"
							data-locked={
								isPackageLocked(packageDetail.lockedAt) ? 'true' : 'false'
							}
							mix={[
								css(packageLockToggleCss),
								on('click', () => onToggleLock()),
							]}
						>
							{packageLockGlyph(isPackageLocked(packageDetail.lockedAt))}
							<span mix={css(visuallyHiddenCss)}>
								{isPackageLocked(packageDetail.lockedAt)
									? `Unlock publishes for ${packageDetail.name}`
									: `Lock publishes for ${packageDetail.name}`}
							</span>
						</button>
						{packageDetail.listingAhead ? (
							<ForkOutdatedCopyButton
								prompt={packageDetail.listingAhead.prompt}
								testId="account-package-listing-ahead"
								href={packageDetail.listingAhead.diffHref}
							/>
						) : packageDetail.forkAhead ? (
							<ForkAheadLink
								href={packageDetail.forkAhead.diffHref}
								testId="account-package-listing-fork-ahead"
							/>
						) : null}
					</div>
					{packageDetail.description ? (
						<p
							mix={css({
								margin: 0,
								color: colors.textMuted,
								overflowWrap: 'anywhere',
							})}
						>
							{packageDetail.description}
						</p>
					) : (
						<p mix={css({ margin: 0, color: colors.textMuted })}>
							This package has no description.
						</p>
					)}
				</div>
				<div mix={css({ display: 'flex', flexWrap: 'wrap', gap: spacing.xs })}>
					{packageDetail.hidden ? (
						<span mix={css(statusBadgeCss)}>Hidden</span>
					) : null}
					{packageDetail.isPrivate ? (
						<span mix={css(statusBadgeCss)}>Not forkable</span>
					) : (
						<span mix={css(communityBadgeCss)}>Forkable</span>
					)}
					{packageDetail.isInternetVisible ? (
						<span mix={css(communityBadgeCss)}>Internet-visible</span>
					) : (
						<span mix={css(statusBadgeCss)}>Private app</span>
					)}
					{packageDetail.hasCommunityListing ? (
						<span mix={css(statusBadgeCss)}>Listed</span>
					) : (
						<span mix={css(statusBadgeCss)}>Not listed</span>
					)}
				</div>
				{viewerCanPublish
					? renderPackagePublishingPanel({
							ownerUsername: handle.props.ownerUsername,
							packageDetail,
						})
					: null}
				{viewerCanPublish ? (
					<section
						mix={css({ display: 'grid', gap: spacing.md })}
						data-testid="package-visibility-controls"
						aria-labelledby="package-visibility-heading"
					>
						<div mix={css({ display: 'grid', gap: spacing.xs })}>
							<h3
								id="package-visibility-heading"
								mix={css({
									margin: 0,
									fontSize: typography.fontSize.base,
									fontWeight: typography.fontWeight.semibold,
									color: colors.text,
								})}
							>
								Visibility
							</h3>
							<p mix={css({ margin: 0, color: colors.textMuted })}>
								Who can open this package and whether the app is public. Type
								the slug to confirm each change.
							</p>
						</div>
						<div mix={css({ display: 'grid', gap: spacing.xs })}>
							<p mix={css({ margin: 0, color: colors.textMuted })}>
								{packageDetail.isPrivate
									? 'Make it public on the community so anyone can read and fork the source. This does not host your app.'
									: 'Turn off public community listing. Public source URLs will 404; existing forks keep their copies. Does not change whether the app is internet-visible.'}
							</p>
							<label mix={css({ display: 'grid', gap: spacing.xs })}>
								<span mix={css(visuallyHiddenCss)}>
									Type {packageDetail.kodyId} to change who can see the source
								</span>
								<input
									value={confirmName}
									placeholder={packageDetail.kodyId}
									data-testid={
										packageDetail.isPrivate
											? 'package-make-public-confirm'
											: 'package-make-private-confirm'
									}
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
											confirmName = event.currentTarget.value
											handle.update()
										}),
									]}
								/>
							</label>
							<button
								type="button"
								disabled={visibilityState === 'submitting'}
								data-testid={
									packageDetail.isPrivate
										? 'package-make-public'
										: 'package-make-private'
								}
								mix={[
									css(getGhostButtonCss()),
									on(
										'click',
										() =>
											void submitVisibility(
												packageDetail,
												packageDetail.isPrivate ? 'public' : 'private',
											),
									),
								]}
							>
								{visibilityState === 'submitting'
									? 'Saving…'
									: packageDetail.isPrivate
										? 'Make public on the community'
										: 'Make private'}
							</button>
							{visibilityMessage ? (
								<p mix={css({ margin: 0, color: colors.danger })} role="alert">
									{visibilityMessage}
								</p>
							) : null}
						</div>
						<div
							mix={css({ display: 'grid', gap: spacing.xs })}
							data-testid="package-internet-visible-controls"
						>
							<p mix={css({ margin: 0, color: colors.textMuted })}>
								{packageDetail.isInternetVisible
									? 'Turning off internet-visible returns the app to signed-in owner serving. Community listing stays unchanged.'
									: 'Host the app at a public URL anyone can open without signing in. Separate from community listing. Do not use this for apps that show private data.'}
							</p>
							{packageDetail.hasApp ? null : (
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									This package has no app yet. You can still review credentials
									after publish; serving stays inactive until an app exists.
								</p>
							)}
							<label mix={css({ display: 'grid', gap: spacing.xs })}>
								<span mix={css(visuallyHiddenCss)}>
									Type {packageDetail.kodyId} to change internet-visible
								</span>
								<input
									value={internetVisibleConfirmName}
									placeholder={packageDetail.kodyId}
									data-testid={
										packageDetail.isInternetVisible
											? 'package-internet-visible-off-confirm'
											: 'package-internet-visible-on-confirm'
									}
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
											internetVisibleConfirmName = event.currentTarget.value
											handle.update()
										}),
									]}
								/>
							</label>
							<div
								mix={css({
									display: 'flex',
									flexWrap: 'wrap',
									gap: spacing.xs,
								})}
							>
								<button
									type="button"
									disabled={internetVisibleState === 'submitting'}
									data-testid={
										packageDetail.isInternetVisible
											? 'package-internet-visible-off'
											: 'package-internet-visible-on'
									}
									mix={[
										css(getGhostButtonCss()),
										on(
											'click',
											() =>
												void submitInternetVisible(
													packageDetail,
													!packageDetail.isInternetVisible,
												),
										),
									]}
								>
									{internetVisibleState === 'submitting'
										? 'Saving…'
										: packageDetail.isInternetVisible
											? 'Turn off internet-visible'
											: 'Make internet-visible'}
								</button>
								<a
									href={routes.communityPackageApproveCapabilities.href({
										username: handle.props.ownerUsername,
										kodyId: packageDetail.kodyId,
									})}
									data-testid="package-approve-capabilities-link"
									mix={css({
										...getPillButtonCss({ size: 'sm' }),
										display: 'inline-flex',
										textDecoration: 'none',
									})}
								>
									Review credentials
								</a>
							</div>
							{internetVisibleMessage ? (
								<p mix={css({ margin: 0, color: colors.danger })} role="alert">
									{internetVisibleMessage}
									{internetVisibleApprovalUrl ? (
										<>
											{' '}
											<a href={internetVisibleApprovalUrl}>
												Open approval page
											</a>
										</>
									) : null}
								</p>
							) : null}
						</div>
					</section>
				) : null}
				{packageDetail.tags.length > 0 ? (
					<RecordChips items={packageDetail.tags} />
				) : null}
				<MetadataGrid
					items={[
						{
							label: 'Kody id',
							value: <IdValue value={packageDetail.kodyId} label="Kody id" />,
						},
						{
							label: 'Package id',
							value: <IdValue value={packageDetail.id} label="package id" />,
						},
						{
							label: 'App',
							value: packageDetail.hasApp ? (
								<a
									href={buildPackageAppPath({
										username: handle.props.ownerUsername,
										kodyId: packageDetail.kodyId,
									})}
									data-testid="open-package-app"
									data-rmx-document
									mix={css(packageAppLinkCss)}
								>
									{renderIcon('share', { size: '1em' })}
									Open Package App
								</a>
							) : (
								'No app'
							),
						},
						{
							label: 'Source id',
							value: (
								<IdValue value={packageDetail.sourceId} label="source id" />
							),
						},
						{
							label: 'Created',
							value: <TimestampValue value={packageDetail.createdAt} />,
						},
						{
							label: 'Updated',
							value: <TimestampValue value={packageDetail.updatedAt} />,
						},
						{
							label: 'Publish lock',
							value: packageDetail.lockedAt
								? `Locked ${formatTimestampDate(packageDetail.lockedAt)}`
								: 'Off',
						},
					]}
				/>
				{viewerCanAdoptCommunityFork && packageDetail.communityFork ? (
					<AccountPackageForkAdoption
						packageDetail={packageDetail}
						communityFork={packageDetail.communityFork}
						onPackagesPayload={handle.props.onPackagesPayload}
					/>
				) : null}
				{viewerCanDelete ? (
					<AccountPackageDeleteDialog
						ownerUsername={handle.props.ownerUsername}
						packageDetail={packageDetail}
					/>
				) : null}
				{packageDetail.searchText ? (
					<details mix={css(accountDisclosureCss)}>
						<summary>Search text</summary>
						<p
							mix={css({
								margin: 0,
								maxHeight: '12rem',
								overflowY: 'auto',
								padding: spacing.sm,
								borderRadius: radius.md,
								border: `1px solid ${colors.border}`,
								backgroundColor: colors.background,
								color: colors.textMuted,
								fontSize: typography.fontSize.sm,
								overflowWrap: 'anywhere',
							})}
						>
							{packageDetail.searchText}
						</p>
					</details>
				) : null}
			</div>
		)
	}
}

function packageLockGlyph(locked: boolean) {
	return renderIcon(locked ? 'lock' : 'lock-unlocked', { size: '1em' })
}

const packageLockToggleCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '1.85rem',
	height: '1.85rem',
	padding: 0,
	border: `1px solid ${colors.border}`,
	borderRadius: '999px',
	backgroundColor: 'transparent',
	color: colors.textMuted,
	cursor: 'pointer',
	flexShrink: 0,
	'&:hover': {
		color: colors.primaryText,
		borderColor: colors.primaryText,
	},
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '2px',
	},
	'&[data-locked="true"]': {
		color: colors.primary,
		borderColor: colors.primary,
		backgroundColor: `oklch(from ${colors.primary} l c h / 0.13)`,
		'&:hover': {
			color: colors.primaryText,
			borderColor: colors.primaryText,
			backgroundColor: `oklch(from ${colors.primary} l c h / 0.2)`,
		},
	},
}

const statusBadgeCss = {
	padding: `${spacing.xs} ${spacing.sm}`,
	borderRadius: radius.full,
	backgroundColor: colors.surface,
	border: `1px solid ${colors.border}`,
	color: colors.textMuted,
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.medium,
}

const communityBadgeCss = {
	...statusBadgeCss,
	backgroundColor: colors.primarySoft,
	border: 'none',
	color: colors.primaryText,
	fontWeight: typography.fontWeight.semibold,
}

const packageAppLinkCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.35rem',
	color: colors.primaryText,
	fontWeight: typography.fontWeight.semibold,
	textDecoration: 'none',
	'&:hover': {
		color: colors.text,
	},
}
