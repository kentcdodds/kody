import { colors, radius, spacing, typography } from '#client/styles/tokens.ts'
import { type Handle } from 'remix/component'

export function OAuthCallbackRoute(_handle: Handle) {
	return () => {
		const params =
			typeof window === 'undefined'
				? new URLSearchParams()
				: new URLSearchParams(window.location.search)
		const error = params.get('error')
		const description = params.get('error_description')
		const code = params.get('code')
		const state = params.get('state')
		const isError = Boolean(error || description)
		const title = isError ? 'Authorization failed' : 'Authorization completed'
		const message = description || error
		const detail = isError ? message : code

		return (
			<section
				css={{
					maxWidth: '32rem',
					margin: '0 auto',
					display: 'grid',
					gap: spacing.lg,
				}}
			>
				<header css={{ display: 'grid', gap: spacing.xs }}>
					<h2
						css={{
							fontSize: typography.fontSize.xl,
							fontWeight: typography.fontWeight.semibold,
							color: colors.text,
						}}
					>
						OAuth callback
					</h2>
					<p css={{ color: colors.textMuted }}>{title}.</p>
				</header>
				{detail ? (
					<pre
						css={{
							margin: 0,
							padding: spacing.md,
							borderRadius: radius.md,
							border: `1px solid ${colors.border}`,
							backgroundColor: colors.surface,
							whiteSpace: 'pre-wrap',
						}}
					>
						{detail}
					</pre>
				) : null}
				{state ? (
					<p css={{ color: colors.textMuted, margin: 0 }}>State: {state}</p>
				) : null}
				<a
					href="/"
					css={{
						color: colors.textMuted,
						fontSize: typography.fontSize.sm,
						textDecoration: 'none',
						'&:hover': {
							textDecoration: 'underline',
						},
					}}
				>
					Back home
				</a>
			</section>
		)
	}
}
