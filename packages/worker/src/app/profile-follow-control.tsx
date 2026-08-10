/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { css } from 'remix/ui'
import { routes } from '#universal/routes.ts'
import { visuallyHiddenCss } from '#universal/styles/style-primitives.ts'
import { colors } from '#universal/styles/tokens.ts'

/**
 * Compact follow / unfollow control used next to usernames on community
 * detail and profile frames. Logged-out viewers get a login link; signed-in
 * viewers get a form POST to the shared profile follow API.
 */
export function renderProfileFollowControl(input: {
	username: string
	loggedIn: boolean
	isFollowing: boolean
	returnTo: string
	followError: string | null
	testId: string
	errorTestId: string
}) {
	if (!input.loggedIn) {
		const loginHref = `${routes.login.href()}?redirectTo=${encodeURIComponent(input.returnTo)}`
		return (
			<a
				href={loginHref}
				title="Follow"
				data-testid={input.testId}
				mix={css(followButtonCss)}
			>
				{renderFollowGlyph(false)}
				<span mix={css(visuallyHiddenCss)}>Follow @{input.username}</span>
			</a>
		)
	}

	return (
		<span mix={css(followControlCss)}>
			<form
				method="post"
				action={routes.profileFollowApiPost.href({ username: input.username })}
				mix={css(followFormCss)}
			>
				<input type="hidden" name="follow" value={String(!input.isFollowing)} />
				<input type="hidden" name="returnTo" value={input.returnTo} />
				<button
					type="submit"
					title={input.isFollowing ? 'Unfollow' : 'Follow'}
					data-testid={input.testId}
					data-following={input.isFollowing ? 'true' : 'false'}
					mix={css(followButtonCss)}
				>
					{renderFollowGlyph(input.isFollowing)}
					<span mix={css(visuallyHiddenCss)}>
						{input.isFollowing
							? `Unfollow @${input.username}`
							: `Follow @${input.username}`}
					</span>
				</button>
			</form>
			{input.followError ? (
				<span
					role="alert"
					data-testid={input.errorTestId}
					mix={css(followErrorCss)}
				>
					{input.followError}
				</span>
			) : null}
		</span>
	)
}

function renderFollowGlyph(following: boolean) {
	return following ? (
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
			<circle cx="8" cy="8" r="5.4" />
			<path d="M5.3 8.1 7.1 9.9 10.8 6.1" />
		</svg>
	) : (
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
			<circle cx="8" cy="8" r="5.4" />
			<path d="M8 5.2v5.6M5.2 8h5.6" />
		</svg>
	)
}

const followControlCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.45rem',
	flexShrink: 0,
	minWidth: 0,
}

const followFormCss = {
	display: 'inline-flex',
	margin: 0,
}

const followErrorCss = {
	color: colors.danger,
	fontSize: '0.85rem',
}

const followButtonCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '1.55rem',
	height: '1.55rem',
	padding: 0,
	border: `1px solid ${colors.border}`,
	borderRadius: '999px',
	backgroundColor: 'transparent',
	color: colors.textMuted,
	textDecoration: 'none',
	cursor: 'pointer',
	flexShrink: 0,
	'&:hover': {
		color: colors.primaryText,
		borderColor: colors.primaryText,
	},
}
