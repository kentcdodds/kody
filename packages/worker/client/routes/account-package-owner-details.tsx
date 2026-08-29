import { type Handle, css } from 'remix/ui'
import { routes } from '#universal/routes.ts'
import { formatTimestampDate } from '#client/format-timestamp.ts'
import { on } from '#client/event-mixin.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { ForkOutdatedCopyButton } from '#universal/fork-outdated-copy-button.tsx'
import {
	getAccentCalloutCss,
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
import { AccountPackageTokens } from './account-package-tokens.tsx'
import { getAccountPackageFilesHref } from '#universal/package-files.ts'
import {
	type AccountPackageDetail,
	type AccountPackagesLoaderData,
} from '#universal/loader-data.ts'

export function isPackageLocked(lockedAt: string | null | undefined) {
	return typeof lockedAt === 'string' && lockedAt.trim().length > 0
}

export function AccountPackageOwnerDetails(
	handle: Handle<{
		packageDetail: AccountPackageDetail
		username: string
		invocationUrlOrigin: string
		currentHref: string
		lockInFlight: boolean
		onToggleLock: () => void
		onPackagesPayload: (payload: AccountPackagesLoaderData) => void
	}>,
) {
	return () => {
		const {
			packageDetail,
			username,
			invocationUrlOrigin,
			currentHref,
			lockInFlight,
			onToggleLock,
			onPackagesPayload,
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
						<span mix={css(statusBadgeCss)}>Private</span>
					) : null}
					{packageDetail.hasCommunityListing ? (
						<span mix={css(communityBadgeCss)}>Community</span>
					) : (
						<span mix={css(statusBadgeCss)}>Not published</span>
					)}
				</div>
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
							value: packageDetail.hasApp ? 'Declares a package app' : 'No app',
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
				<div mix={css(getAccentCalloutCss())}>
					<p mix={css({ margin: 0, color: colors.textMuted })}>
						{packageDetail.lockedAt
							? 'Publishes stay on this reviewed tree until you promote a commit on the website. Click the lock icon to unlock.'
							: 'Click the lock icon so agents cannot publish without your approval.'}
					</p>
					{packageDetail.lockedAt ? (
						<div
							mix={css({
								display: 'flex',
								flexWrap: 'wrap',
								gap: spacing.xs,
							})}
						>
							<a
								href={routes.accountPackageApprovePublish.href({
									packageId: packageDetail.id,
								})}
								data-testid="account-approve-publish"
								mix={css({
									...getPillButtonCss({ size: 'sm' }),
									display: 'inline-flex',
									textDecoration: 'none',
								})}
							>
								Approve a publish
							</a>
						</div>
					) : null}
				</div>
				<a
					href={getAccountPackageFilesHref({
						packageId: packageDetail.id,
					})}
					data-testid="account-browse-files"
					mix={css({
						...getGhostButtonCss({ size: 'sm' }),
						width: 'fit-content',
					})}
				>
					Browse files
				</a>
				<AccountPackageTokens
					packageDetail={packageDetail}
					currentHref={currentHref}
					username={username}
					invocationUrlOrigin={invocationUrlOrigin}
					onPackagesPayload={onPackagesPayload}
				/>
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

export function packageLockGlyph(locked: boolean) {
	return (
		<svg
			viewBox="0 0 16 16"
			width="1em"
			height="1em"
			aria-hidden="true"
			focusable={false}
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			{locked ? (
				<path d="M5.2 7.4V5.8a2.8 2.8 0 0 1 5.6 0v1.6" />
			) : (
				<path d="M5.2 7.4V5.6a2.8 2.8 0 0 1 5.2-1.4" />
			)}
			<rect x="3.6" y="7.4" width="8.8" height="6.4" rx="1.3" />
		</svg>
	)
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
