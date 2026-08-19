import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { getPillButtonCss } from '#universal/styles/style-primitives.ts'

type UndoToastProps = {
	message: string
	undoLabel?: string
	onUndo: () => void
}

export function UndoToast(handle: Handle<UndoToastProps>) {
	return () => (
		<div
			role="status"
			aria-live="polite"
			data-testid="undo-toast"
			mix={css({
				position: 'fixed',
				left: '50%',
				bottom: spacing.xl,
				transform: 'translateX(-50%)',
				zIndex: 1000,
				display: 'flex',
				alignItems: 'center',
				gap: spacing.md,
				padding: `${spacing.sm} ${spacing.md}`,
				backgroundColor: colors.surface,
				color: colors.text,
				boxShadow: shadows.md,
				borderRadius: radius.lg,
				border: `1px solid ${colors.border}`,
				maxWidth: 'min(36rem, calc(100vw - 2rem))',
			})}
		>
			<p
				mix={css({
					margin: 0,
					fontSize: typography.fontSize.sm,
					minWidth: 0,
				})}
			>
				{handle.props.message}
			</p>
			<button
				type="button"
				data-testid="undo-toast-undo"
				mix={[
					on('click', () => {
						handle.props.onUndo()
					}),
					css(getPillButtonCss({ size: 'sm' })),
				]}
			>
				{handle.props.undoLabel ?? 'Undo'}
			</button>
		</div>
	)
}
