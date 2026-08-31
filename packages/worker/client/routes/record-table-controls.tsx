import { css, ref, type Handle, type RemixNode } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getAuthInputCss,
	getSelectCss,
} from '#universal/styles/style-primitives.ts'
import {
	acknowledgeRecordTableSearchInput,
	reconcileRecordTableSearchExternalValue,
	type RecordTableSearchSync,
} from './record-table-search-sync.ts'

type Slot = RemixNode

/*
 * Toolbar controls. These came out of a sidebar that stacked a visible label
 * over each field and spent ~230px of height on three of them; on one row
 * they cost 48px, so the label becomes the control's accessible name.
 */

/**
 * Live filter fields write the query into the URL on every keystroke. A
 * Remix-controlled `value` lets the first character schedule a restore of the
 * previous (empty) query, and WebKit's search cancel control appears on that
 * same keystroke — either one drops focus and the reader has to click back in.
 * The field stays uncontrolled. URL/back-button updates apply immediately
 * when it is not focused, and on blur if they arrived while it was. A
 * keystroke records the typed string as the last applied value so a later
 * render that returns `q` to that value (clear, or back to the same query)
 * cannot leave a stale pending string for blur to write back.
 */
const searchCancelHiddenCss = {
	'&::-webkit-search-decoration': {
		WebkitAppearance: 'none',
		appearance: 'none',
	},
	'&::-webkit-search-cancel-button': {
		WebkitAppearance: 'none',
		appearance: 'none',
		display: 'none',
	},
	'&::-webkit-search-results-button': {
		WebkitAppearance: 'none',
		appearance: 'none',
	},
	'&::-webkit-search-results-decoration': {
		WebkitAppearance: 'none',
		appearance: 'none',
	},
} as const

export function RecordTableSearch(
	handle: Handle<{
		label: string
		placeholder: string
		value: string
		onInput: (value: string) => void
	}>,
) {
	let input: HTMLInputElement | null = null
	const initialValue = handle.props.value
	let sync: RecordTableSearchSync = {
		lastExternalValue: initialValue,
		pendingExternalValue: null,
	}

	function applyExternalValue(nextValue: string) {
		if (input) input.value = nextValue
		sync = acknowledgeRecordTableSearchInput(nextValue)
	}

	return () => {
		const nextValue = handle.props.value
		const focused = Boolean(input && document.activeElement === input)
		const reconciled = reconcileRecordTableSearchExternalValue(
			sync,
			nextValue,
			focused,
		)
		sync = reconciled.state
		if (reconciled.applyValue !== null)
			applyExternalValue(reconciled.applyValue)
		return (
			<input
				type="search"
				data-field-ring
				defaultValue={initialValue}
				placeholder={handle.props.placeholder}
				aria-label={handle.props.label}
				mix={[
					ref((node, signal) => {
						input = node as HTMLInputElement
						signal.addEventListener('abort', () => {
							if (input === node) input = null
						})
					}),
					on('input', (event) => {
						const value = (event.currentTarget as HTMLInputElement).value
						sync = acknowledgeRecordTableSearchInput(value)
						handle.props.onInput(value)
					}),
					on('blur', () => {
						if (sync.pendingExternalValue !== null) {
							applyExternalValue(sync.pendingExternalValue)
						}
					}),
					css({
						...getAuthInputCss(),
						flex: '1 1 12rem',
						minWidth: '7rem',
						width: 'auto',
						...searchCancelHiddenCss,
					}),
				]}
			/>
		)
	}
}

export function RecordTableSelect(
	handle: Handle<{
		label: string
		value: string
		onChange: (value: string) => void
		children: Slot
	}>,
) {
	return () => (
		<select
			data-field-ring
			value={handle.props.value}
			aria-label={handle.props.label}
			mix={[
				on('change', (event) =>
					handle.props.onChange(
						(event.currentTarget as HTMLSelectElement).value,
					),
				),
				css({
					...getSelectCss(),
					width: 'auto',
					flex: 'none',
					'@container (max-width: 620px)': { flex: '1 1 8rem' },
				}),
			]}
		>
			{handle.props.children}
		</select>
	)
}

/**
 * One-line cell text with an ellipsis. A table cell will not shrink below its
 * content, so the clamp has to live on a block inside it — and the width is
 * `min(…, 100%)` because below 620px that block sits in a card that can be
 * narrower than the clamp itself.
 */
export function recordCellClamp(ch: number) {
	return {
		display: 'block',
		minWidth: 0,
		maxWidth: `min(${ch}ch, 100%)`,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap' as const,
	}
}

/** Date/duration cell: one token, aligned figures, quieter than the name. */
export const recordStampCss = {
	whiteSpace: 'nowrap' as const,
	fontVariantNumeric: 'tabular-nums',
	color: colors.textMuted,
	fontSize: '0.84rem',
}

export const visuallyHiddenCss = {
	position: 'absolute' as const,
	width: '1px',
	height: '1px',
	padding: 0,
	margin: '-1px',
	overflow: 'hidden',
	clip: 'rect(0 0 0 0)',
	whiteSpace: 'nowrap' as const,
	border: 0,
}

/**
 * A boolean column reads as a mark you can scan down, not a word you have to
 * read on every row. The title carries the meaning for anyone who needs it.
 */
export function RecordDot(handle: Handle<{ active: boolean; title: string }>) {
	return () => (
		<span
			title={handle.props.title}
			mix={css({
				display: 'inline-grid',
				placeContent: 'center',
				width: '1.2rem',
				height: '1.2rem',
				borderRadius: radius.full,
				border: `1px solid ${handle.props.active ? colors.primary : colors.border}`,
				backgroundColor: handle.props.active
					? colors.primarySoft
					: 'transparent',
				color: handle.props.active ? colors.primaryText : colors.textMuted,
				fontSize: '0.68rem',
			})}
		>
			<span aria-hidden="true">{handle.props.active ? '●' : '–'}</span>
			<span mix={css(visuallyHiddenCss)}>{handle.props.title}</span>
		</span>
	)
}

const chipCss = {
	display: 'inline-block',
	padding: `0 ${spacing.sm}`,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
	color: colors.textMuted,
	fontSize: typography.fontSize.xs,
	lineHeight: '1.5rem',
	whiteSpace: 'nowrap' as const,
}

const activeChipCss = {
	...chipCss,
	borderColor: colors.primary,
	color: colors.primaryText,
	backgroundColor: colors.primarySoft,
}

/** Tags, roles, scopes — a short set of labels in one cell or one band field. */
export function RecordChips(
	handle: Handle<{ items: Array<string>; active?: boolean; empty?: string }>,
) {
	return () => {
		if (handle.props.items.length === 0) {
			return handle.props.empty ? (
				<span mix={css({ color: colors.textMuted })}>{handle.props.empty}</span>
			) : null
		}
		return (
			<span
				mix={css({
					display: 'flex',
					gap: '0.3rem',
					flexWrap: 'wrap',
					overflow: 'hidden',
				})}
			>
				{handle.props.items.map((item) => (
					<span
						key={item}
						mix={css(handle.props.active ? activeChipCss : chipCss)}
					>
						{item}
					</span>
				))}
			</span>
		)
	}
}
