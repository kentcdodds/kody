import { css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { type ProfileVisibility } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { UserAvatar } from '#universal/user-avatar.tsx'
import { colors, radius, shadows, spacing } from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
	hoverMq,
	mutedLinkCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import {
	AccountManagementPanel,
	accountDisclosureCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
	accountTextareaCss,
	verifiedPillCss,
} from '#client/routes/account-management-components.tsx'

export type AccountProfilePanelProps = {
	email: string
	emailVerified: boolean
	username: string
	draftUsername: string
	draftDisplayName: string
	draftBio: string
	draftProfileVisibility: ProfileVisibility
	draftEmail: string
	emailChangePassword: string
	avatarUrl: string | null
	avatarStatus: 'idle' | 'editing' | 'uploading' | 'removing'
	isSaving: boolean
	isSendingEmailChange: boolean
	profileUnchanged: boolean
	normalizedDraftUsername: string
	normalizedDraftEmail: string
	emailChangeMessage: string | null
	emailChangeTone: 'error' | 'info'
	onProfileSubmit: (event: SubmitEvent) => void
	onEmailChangeSubmit: (event: SubmitEvent) => void
	onAvatarSelected: (event: Event) => void
	onRemoveAvatar: () => void
	onDraftUsernameInput: (event: InputEvent) => void
	onDraftDisplayNameChange: (value: string) => void
	onDraftBioChange: (value: string) => void
	onDraftProfileVisibilityChange: (value: ProfileVisibility) => void
	onDraftEmailInput: (event: InputEvent) => void
	onEmailChangePasswordInput: (event: InputEvent) => void
}

export function renderAccountProfilePanel(props: AccountProfilePanelProps) {
	const {
		email,
		emailVerified,
		username,
		draftUsername,
		draftDisplayName,
		draftBio,
		draftProfileVisibility,
		draftEmail,
		emailChangePassword,
		avatarUrl,
		avatarStatus,
		isSaving,
		isSendingEmailChange,
		profileUnchanged,
		normalizedDraftUsername,
		normalizedDraftEmail,
		emailChangeMessage,
		emailChangeTone,
		onProfileSubmit,
		onEmailChangeSubmit,
		onAvatarSelected,
		onRemoveAvatar,
		onDraftUsernameInput,
		onDraftDisplayNameChange,
		onDraftBioChange,
		onDraftProfileVisibilityChange,
		onDraftEmailInput,
		onEmailChangePasswordInput,
	} = props
	return (
		<AccountManagementPanel
			title="Profile"
			description="Your username is unique. Display name, bio, avatar, and visibility control your public community profile."
		>
			<form
				mix={[
					css({ display: 'grid', gap: spacing.md, maxWidth: '34rem' }),
					on('submit', onProfileSubmit),
				]}
			>
				<div mix={css(avatarSectionCss)} data-testid="account-avatar">
					<label
						mix={css({
							...avatarEditCss,
							cursor:
								avatarStatus !== 'idle' || isSaving ? 'not-allowed' : 'pointer',
							opacity: avatarStatus !== 'idle' || isSaving ? 0.7 : 1,
						})}
					>
						<UserAvatar
							displayName={draftDisplayName || username}
							avatarUrl={avatarUrl}
							size={accountAvatarSize}
							testId="account-avatar-image"
						/>
						<input
							type="file"
							name="avatar"
							accept="image/*,.heic,.heif"
							disabled={avatarStatus !== 'idle' || isSaving}
							data-testid="account-avatar-file"
							mix={[
								css(visuallyHiddenCss),
								on('change', (event) => {
									void onAvatarSelected(event)
								}),
							]}
						/>
						<span
							data-avatar-edit-affordance
							mix={css(avatarEditAffordanceCss)}
						>
							{avatarEditIcon()}
						</span>
						<span mix={css(visuallyHiddenCss)}>Change avatar</span>
					</label>
					{avatarUrl ? (
						<button
							type="button"
							disabled={avatarStatus !== 'idle' || isSaving}
							mix={[
								css(compactGhostButtonCss),
								on('click', () => {
									void onRemoveAvatar()
								}),
							]}
						>
							{avatarStatus === 'removing' ? 'Removing...' : 'Remove avatar'}
						</button>
					) : null}
				</div>
				<label mix={css(accountFieldCss)}>
					<span mix={css(accountFieldLabelCss)}>Username</span>
					<input
						type="text"
						name="username"
						data-field-ring
						required
						autoComplete="username"
						pattern="[A-Za-z0-9][A-Za-z0-9-]{1,30}[A-Za-z0-9]"
						title="Use 3 to 32 letters, numbers, and hyphens. Start and end with a letter or number."
						value={draftUsername}
						mix={[css(accountInputCss), on('input', onDraftUsernameInput)]}
					/>
				</label>
				<label mix={css(accountFieldCss)}>
					<span mix={css(accountFieldLabelCss)}>Display name</span>
					<input
						type="text"
						name="displayName"
						data-field-ring
						maxLength={50}
						autoComplete="nickname"
						value={draftDisplayName}
						mix={[
							css(accountInputCss),
							on('input', (event) => {
								onDraftDisplayNameChange(
									(event.currentTarget as HTMLInputElement).value,
								)
							}),
						]}
					/>
				</label>
				<label mix={css(accountFieldCss)}>
					<span mix={css(accountFieldLabelCss)}>Bio</span>
					<textarea
						name="bio"
						data-field-ring
						maxLength={500}
						rows={3}
						value={draftBio}
						mix={[
							css(accountTextareaCss),
							on('input', (event) => {
								onDraftBioChange(
									(event.currentTarget as HTMLTextAreaElement).value,
								)
							}),
						]}
					/>
				</label>
				<fieldset mix={css({ margin: 0, padding: 0, border: 'none' })}>
					<legend mix={css(accountFieldLabelCss)}>Profile visibility</legend>
					<label
						mix={css({
							display: 'flex',
							gap: spacing.sm,
							alignItems: 'center',
							marginTop: spacing.sm,
						})}
					>
						<input
							type="radio"
							name="profileVisibility"
							checked={draftProfileVisibility === 'public'}
							mix={[
								on('change', () => {
									onDraftProfileVisibilityChange('public')
								}),
							]}
						/>
						<span>Public</span>
					</label>
					<label
						mix={css({
							display: 'flex',
							gap: spacing.sm,
							alignItems: 'center',
							marginTop: spacing.xs,
						})}
					>
						<input
							type="radio"
							name="profileVisibility"
							checked={draftProfileVisibility === 'private'}
							mix={[
								on('change', () => {
									onDraftProfileVisibilityChange('private')
								}),
							]}
						/>
						<span>Private</span>
					</label>
					<p mix={css(accountFieldNoteCss)}>
						Private hides your profile, public package list, and activity from
						others.
					</p>
				</fieldset>
				<p mix={css(accountFieldNoteCss)}>
					Email: {email}
					{emailVerified ? (
						<span mix={css(verifiedPillCss)}>verified</span>
					) : (
						' (unverified)'
					)}
				</p>
				<p mix={css({ margin: 0 })}>
					<a href={routes.profile.href({ username })} mix={css(mutedLinkCss)}>
						View public profile
					</a>
				</p>
				{normalizedDraftUsername !== username ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Changing your username updates every saved package to the new{' '}
						<code>@{normalizedDraftUsername}</code> scope with an automatic
						commit. That can affect third-party integrations and dynamic
						invocations that still reference <code>@{username}</code>. Community
						listings already pinned to the latest package commit are republished
						automatically.
					</p>
				) : null}
				<div>
					<button
						type="submit"
						disabled={isSaving || profileUnchanged}
						mix={css(compactPillButtonCss)}
					>
						{isSaving ? 'Saving...' : 'Save profile'}
					</button>
				</div>
			</form>
			<details
				mix={css({
					...accountDisclosureCss,
					marginTop: '0.6rem',
				})}
			>
				<summary>Change email</summary>
				<form
					{...passwordManagerIgnoreProps}
					mix={[
						css({
							display: 'grid',
							gap: spacing.md,
							maxWidth: '26rem',
						}),
						on('submit', onEmailChangeSubmit),
					]}
				>
					<p mix={css(accountFieldNoteCss)}>
						Enter your current password. We will send a verification link to the
						new address before changing your account email.
					</p>
					<label mix={css(accountFieldCss)}>
						<span mix={css(accountFieldLabelCss)}>New email</span>
						<input
							type="email"
							name="email"
							data-field-ring
							required
							autoComplete="email"
							value={draftEmail}
							mix={[css(accountInputCss), on('input', onDraftEmailInput)]}
						/>
					</label>
					<label mix={css(accountFieldCss)}>
						<span mix={css(accountFieldLabelCss)}>Current password</span>
						<input
							type="password"
							name="password"
							data-field-ring
							required
							{...passwordManagerIgnoreProps}
							value={emailChangePassword}
							mix={[
								css(accountInputCss),
								on('input', onEmailChangePasswordInput),
							]}
						/>
					</label>
					<div>
						<button
							type="submit"
							disabled={
								isSendingEmailChange ||
								normalizedDraftEmail === email.trim().toLowerCase()
							}
							mix={css(compactGhostButtonCss)}
						>
							{isSendingEmailChange ? 'Sending...' : 'Send verification link'}
						</button>
					</div>
					{emailChangeMessage ? (
						<p
							role="status"
							mix={css({
								color: emailChangeTone === 'error' ? colors.error : colors.text,
								margin: 0,
							})}
						>
							{emailChangeMessage}
						</p>
					) : null}
				</form>
			</details>
		</AccountManagementPanel>
	)
}

/* `.account-form .button` / `.account-actions .button` — the prototype's
 * compact pill sizing for in-section actions. */
const compactPillButtonCss = getPillButtonCss({ size: 'sm' })

const compactGhostButtonCss = getGhostButtonCss({ size: 'sm' })

const accountAvatarSize = 128

const avatarSectionCss = {
	display: 'grid',
	gap: spacing.sm,
	justifyItems: 'start' as const,
}

const avatarEditCss = {
	position: 'relative' as const,
	display: 'inline-block',
	width: `${accountAvatarSize}px`,
	height: `${accountAvatarSize}px`,
	borderRadius: radius.full,
	[hoverMq]: {
		'& [data-avatar-edit-affordance]': {
			opacity: 0,
		},
		'&:hover [data-avatar-edit-affordance], &:focus-within [data-avatar-edit-affordance]':
			{
				opacity: 1,
			},
	},
}

const avatarEditAffordanceCss = {
	position: 'absolute' as const,
	right: '0.15rem',
	bottom: '0.15rem',
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '2.25rem',
	height: '2.25rem',
	borderRadius: radius.full,
	backgroundColor: colors.surface,
	color: colors.text,
	border: `1px solid ${colors.border}`,
	boxShadow: shadows.md,
	opacity: 1,
	pointerEvents: 'none' as const,
}

function avatarEditIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="16"
			height="16"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M12 20h9" />
			<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
		</svg>
	)
}
