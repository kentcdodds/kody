import { css } from 'remix/component'
import { on } from '#client/event-mixin.ts'
import { ProviderIcon } from '#client/provider-icons.tsx'
import { type AuthProviderInfo } from '#client/social-sign-in.ts'
import { colors } from '#universal/styles/tokens.ts'
import { getGhostButtonCss } from '#universal/styles/style-primitives.ts'

/**
 * Shared provider buttons used by `/login` and `/oauth/authorize` so MCP
 * consent does not grow a second social-sign-in lane.
 */
export function renderSocialSignInButtons(input: {
	providers: ReadonlyArray<AuthProviderInfo>
	disabled: boolean
	onProviderClick: (providerId: string) => void
	/** Optional Remix `data-rise` entrance attrs for the login canvas. */
	dividerAttrs?: Record<string, unknown>
	buttonsAttrs?: Record<string, unknown>
}) {
	if (input.providers.length === 0) return null
	return (
		<>
			<div
				{...input.dividerAttrs}
				role="separator"
				aria-label="or continue with"
				mix={css(authDividerCss)}
			>
				<span>or continue with</span>
			</div>
			<div {...input.buttonsAttrs} mix={css(authOauthCss)}>
				{input.providers.map((provider) => (
					<button
						key={provider.id}
						type="button"
						disabled={input.disabled}
						aria-label={`Continue with ${provider.label}`}
						data-testid={`social-sign-in-${provider.id}`}
						mix={[
							css(oauthButtonCss),
							on('click', () => input.onProviderClick(provider.id)),
						]}
					>
						<ProviderIcon providerId={provider.id} size="1.4rem" />
					</button>
				))}
			</div>
		</>
	)
}

const authDividerCss = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.9rem',
	color: colors.textMuted,
	fontSize: '0.88rem',
	'&::before': {
		content: '""',
		flex: 1,
		height: '1px',
		background: colors.border,
	},
	'&::after': {
		content: '""',
		flex: 1,
		height: '1px',
		background: colors.border,
	},
}

const authOauthCss = {
	display: 'flex',
	justifyContent: 'center',
	flexWrap: 'wrap' as const,
	gap: '0.7rem',
}

const oauthButtonCss = {
	...getGhostButtonCss(),
	flex: '0 0 auto',
	width: '3rem',
	height: '3rem',
	minWidth: '3rem',
	padding: 0,
	'& svg': {
		display: 'block',
		flexShrink: 0,
	},
}
