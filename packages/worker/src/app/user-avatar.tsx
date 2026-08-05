/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type Handle, css } from 'remix/ui'
import { colors, radius, typography } from '#client/styles/tokens.ts'

export type UserAvatarProps = {
	displayName: string
	avatarUrl: string | null
	size: number
	testId?: string
	/**
	 * `well` is the redesign's avatar well — page surface behind a hairline
	 * ring, initials in the display face and the accent colour. It has to be a
	 * variant rather than something a caller layers on from a wrapper: every
	 * `css()` class gets its own `@layer rmx.<class>`, and this component's
	 * class is registered after its caller's, so a caller's descendant rule
	 * silently loses to whatever is declared here.
	 */
	variant?: 'plain' | 'well'
}

export function UserAvatar(handle: Handle<UserAvatarProps>) {
	// Props must be read inside the render function so updates (for example
	// the account page swapping the avatar after an upload) re-render.
	return () => {
		const { displayName, avatarUrl, size, testId, variant } = handle.props
		const initial = displayName.trim().charAt(0).toUpperCase() || '?'
		const well = variant === 'well'
		const sizeStyle = {
			width: `${size}px`,
			height: `${size}px`,
			borderRadius: radius.full,
			flexShrink: '0',
			boxSizing: 'border-box' as const,
			...(well ? { border: `1px solid ${colors.border}` } : {}),
		}
		const fill = well ? colors.surface : colors.primarySoftest

		return avatarUrl ? (
			<img
				src={avatarUrl}
				alt=""
				width={size}
				height={size}
				data-testid={testId}
				mix={css({
					...sizeStyle,
					objectFit: 'cover',
					display: 'block',
					backgroundColor: fill,
				})}
			/>
		) : (
			<span
				aria-hidden="true"
				data-testid={testId}
				mix={css({
					...sizeStyle,
					display: 'inline-flex',
					alignItems: 'center',
					justifyContent: 'center',
					backgroundColor: fill,
					color: well ? colors.primaryText : colors.textMuted,
					fontFamily: well ? typography.fontFamilyDisplay : undefined,
					fontSize: `${Math.max(well ? 11 : 12, Math.round(size * (well ? 0.36 : 0.4)))}px`,
					fontWeight: well ? 700 : typography.fontWeight.semibold,
					lineHeight: 1,
					userSelect: 'none',
				})}
			>
				{initial}
			</span>
		)
	}
}
