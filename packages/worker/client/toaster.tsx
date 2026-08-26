import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import {
	listToasts,
	subscribeToasts,
	toast,
	type ToastRecord,
	type ToastTone,
} from '#client/toast.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
	mergeCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

export function Toaster(handle: Handle) {
	const unsubscribe = subscribeToasts(() => {
		handle.update()
	})
	handle.signal.addEventListener('abort', unsubscribe, { once: true })

	return () => {
		const toasts = listToasts()
		if (toasts.length === 0) return null

		return (
			<ol
				data-testid="toaster"
				aria-label="Notifications"
				mix={css(toasterListCss)}
			>
				{toasts.map((item) => (
					<li key={item.id} mix={css(toastItemCss)}>
						<ToastCard item={item} />
					</li>
				))}
			</ol>
		)
	}
}

function ToastCard(handle: Handle<{ item: ToastRecord }>) {
	return () => {
		const item = handle.props.item
		const live = item.tone === 'error' ? 'assertive' : 'polite'
		const role = item.tone === 'error' ? 'alert' : 'status'

		return (
			<div
				role={role}
				aria-live={live}
				aria-atomic="true"
				data-testid="toast"
				data-toast-tone={item.tone}
				mix={css(toastCardCss(item.tone))}
			>
				<div mix={css(toastCopyCss)}>
					<p mix={css(toastMessageCss)}>{item.message}</p>
					{item.description ? (
						<p mix={css(toastDescriptionCss)}>{item.description}</p>
					) : null}
				</div>
				{item.action ? (
					<button
						type="button"
						data-testid="toast-action"
						mix={[
							css(toastActionButtonCss),
							on('click', () => {
								item.action?.onClick()
							}),
						]}
					>
						{item.action.label}
					</button>
				) : null}
				{item.dismissible ? (
					<button
						type="button"
						aria-label="Dismiss notification"
						data-testid="toast-dismiss"
						mix={[
							css(toastDismissButtonCss),
							on('click', () => {
								toast.dismiss(item.id)
							}),
						]}
					>
						×
					</button>
				) : null}
			</div>
		)
	}
}

function toastAccent(tone: ToastTone) {
	switch (tone) {
		case 'success':
			return colors.primary
		case 'error':
			return colors.error
		case 'info':
			return colors.textMuted
		default: {
			const exhaustive: never = tone
			return exhaustive
		}
	}
}

const toasterListCss = {
	position: 'fixed' as const,
	left: '50%',
	bottom: `max(${spacing.xl}, env(safe-area-inset-bottom))`,
	transform: 'translateX(-50%)',
	zIndex: 1100,
	display: 'grid',
	gap: spacing.sm,
	margin: 0,
	padding: 0,
	listStyle: 'none',
	width: 'min(36rem, calc(100vw - 2rem))',
	pointerEvents: 'none' as const,
}

const toastItemCss = {
	pointerEvents: 'auto' as const,
}

function toastCardCss(tone: ToastTone) {
	return {
		display: 'flex',
		alignItems: 'center',
		gap: spacing.md,
		padding: `${spacing.sm} ${spacing.md}`,
		backgroundColor: colors.surface,
		color: colors.text,
		boxShadow: shadows.md,
		borderRadius: radius.lg,
		border: `1px solid ${colors.border}`,
		borderLeft: `3px solid ${toastAccent(tone)}`,
		borderTopLeftRadius: 0,
		borderBottomLeftRadius: 0,
	}
}

const toastCopyCss = {
	display: 'grid',
	gap: '0.15rem',
	minWidth: 0,
	flex: 1,
}

const toastMessageCss = {
	margin: 0,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.medium,
}

const toastDescriptionCss = {
	margin: 0,
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
}

const toastActionButtonCss = getPillButtonCss({ size: 'sm' })

const toastDismissButtonCss = mergeCss(getGhostButtonCss({ size: 'sm' }), {
	minWidth: '2.25rem',
	minHeight: '2.25rem',
	padding: 0,
	fontSize: '1.25rem',
	lineHeight: 1,
})
