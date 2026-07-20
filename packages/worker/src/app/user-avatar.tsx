/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type Handle, css } from 'remix/ui'
import { colors, radius, typography } from '#client/styles/tokens.ts'

export type UserAvatarProps = {
	displayName: string
	avatarUrl: string | null
	size: number
	testId?: string
}

export function UserAvatar(handle: Handle<UserAvatarProps>) {
	// Props must be read inside the render function so updates (for example
	// the account page swapping the avatar after an upload) re-render.
	return () => {
		const { displayName, avatarUrl, size, testId } = handle.props
		const initial = displayName.trim().charAt(0).toUpperCase() || '?'
		const sizeStyle = {
			width: `${size}px`,
			height: `${size}px`,
			borderRadius: radius.full,
			flexShrink: '0',
		}

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
					backgroundColor: colors.primarySoftest,
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
					backgroundColor: colors.primarySoftest,
					color: colors.textMuted,
					fontSize: `${Math.max(12, Math.round(size * 0.4))}px`,
					fontWeight: typography.fontWeight.semibold,
					lineHeight: 1,
					userSelect: 'none',
				})}
			>
				{initial}
			</span>
		)
	}
}
