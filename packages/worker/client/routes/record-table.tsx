import { css, type Handle } from 'remix/ui'
import { shouldRouterHandleClick } from '#client/client-router.tsx'
import { on } from '#client/event-mixin.ts'
import {
	colors,
	radius,
	spacing,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getAuthInputCss,
	getSelectCss,
	getSurfaceCardCss,
	hoverMq,
} from '#universal/styles/style-primitives.ts'

/*
 * The account and admin list/detail screens, as one table.
 *
 * Decision 0010: the record gets the whole content column instead of the
 * 434px right half of a split, and `mode` chooses where it renders rather
 * than which component the screen composes. Rows stay real anchors built
 * from `createListDetailRoute`, so the selected record is still in the URL
 * and the scroll-preserving navigation from #1270 keeps working.
 *
 * Sizing is answered by container queries, not viewport breakpoints: these
 * tables live inside a 200px-railed shell, so the viewport says very little
 * about how much room the table actually has.
 */

type Slot = any

export type RecordTableColumn = {
	/** Pairs the column with the value under the same key in `row.cells`. */
	key: string
	label: string
	/** Numeric columns right-align and take tabular figures. */
	align?: 'end'
	/**
	 * Priority at which this column stops earning its width and drops out.
	 * `3` goes first. Columns squeeze equally without this, which is how a
	 * table ends up with five unreadable ones instead of three readable.
	 */
	drop?: 1 | 2 | 3
	/**
	 * The row's heading: carries the link, and is the card's title rather
	 * than a labeled field below 620px. Exactly one column should set it.
	 */
	primary?: boolean
}

export type RecordTableRow = {
	id: string
	/** Omitted for `mode: 'none'`, and while a mutation is in flight. */
	href?: string
	/** Keyed by column key; a missing key renders an empty cell. */
	cells: Record<string, Slot>
}

type RecordTableProps = {
	/**
	 * `expand` unfolds the record inside the table under its own row,
	 * `pane` renders it below the table, `none` is a table with no selection.
	 * Prefer `pane` for large editors (decision 0010); `expand` may still host
	 * an editor when the screen deliberately keeps the form under its row.
	 */
	mode: 'expand' | 'pane' | 'none'
	/**
	 * Names both the region and the table for assistive tech; there is no
	 * visible caption. The region carries it too because an empty collection
	 * renders no table, and the toolbar and count would otherwise sit in an
	 * unnamed part of the page.
	 */
	ariaLabel: string
	columns: Array<RecordTableColumn>
	rows: Array<RecordTableRow>
	selectedId?: string | null
	/**
	 * The already-built record for `selectedId`. It is a prop rather than a
	 * `renderRecord(row)` callback because every one of these screens loads
	 * the record separately from the list — the detail is a different payload
	 * than the row, not a richer view of it.
	 */
	record?: Slot
	/** Collection controls: search, filters, the sort select. */
	toolbar?: Slot
	countLabel?: string
	/**
	 * A refetch is in flight. Reported in the count slot, which is already on
	 * the page — a page-level "Loading…" line above the table reflowed
	 * everything below it on every keystroke of a search that refetches.
	 */
	busy?: boolean
	emptyLabel?: string
	/** Below the table, inside its pane: the infinite-list "Load more" control. */
	footer?: Slot
	/**
	 * Pre-navigation state resets (clear messages, collapse confirmations) for
	 * the row being opened. Runs only for clicks the router takes as an SPA
	 * navigation; the id lets an editor seed its draft from the new selection
	 * before the loader answers.
	 */
	onNavigate?: (rowId: string) => void
	/**
	 * Scroll cap for `pane` and `none`. `expand` ignores it — see below.
	 */
	scrollHeight?: string
}

const defaultScrollHeight = '22rem'

/**
 * Columns drop one priority at a time as the container narrows, then the
 * whole table becomes cards. Each threshold is its own class so a cell can
 * carry exactly one.
 */
const dropCss = {
	1: css({ '@container (max-width: 680px)': { display: 'none' } }),
	2: css({ '@container (max-width: 780px)': { display: 'none' } }),
	3: css({ '@container (max-width: 900px)': { display: 'none' } }),
} as const

const numericCss = css({
	textAlign: 'right',
	fontVariantNumeric: 'tabular-nums',
	'@container (max-width: 620px)': { textAlign: 'left' },
})

const shellCss = {
	containerType: 'inline-size',
	display: 'grid',
	gap: spacing.lg,
	minWidth: 0,
}

const paneCss = {
	...getSurfaceCardCss(),
	padding: 0,
	minWidth: 0,
	// Clip only the corners; the table scroller owns overflow so wide rows
	// scroll instead of disappearing under the rounded card edge.
	overflow: 'clip',
}

const tableScrollerCss = {
	width: '100%',
	minWidth: 0,
	overflowX: 'auto' as const,
	WebkitOverflowScrolling: 'touch' as const,
}

const toolbarCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	flexWrap: 'wrap' as const,
	padding: `0.7rem ${spacing.md}`,
	borderBottom: `1px solid ${colors.border}`,
	'@container (max-width: 620px)': {
		gap: spacing.xs,
	},
}

const countCss = {
	margin: `0 0 0 auto`,
	fontSize: typography.fontSize.xs,
	color: colors.textMuted,
	whiteSpace: 'nowrap' as const,
	fontVariantNumeric: 'tabular-nums',
	// A refetch dims the count rather than replacing its text. The search field
	// beside it is `flex: 1 1 12rem`, so any width change here resizes the box
	// the reader is typing into.
	transition: `opacity 120ms ${transitions.easeOut}`,
	'&[data-busy]': { opacity: 0.45 },
	'@container (max-width: 620px)': { marginLeft: 0 },
}

const tableCss = {
	width: '100%',
	minWidth: '100%',
	borderCollapse: 'collapse' as const,
	fontSize: typography.fontSize.sm,
}

const headCellCss = {
	position: 'sticky' as const,
	top: 0,
	zIndex: 1,
	textAlign: 'left' as const,
	fontSize: '0.7rem',
	fontWeight: 700,
	letterSpacing: '0.08em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
	padding: `${spacing.xs} ${spacing.md}`,
	borderBottom: `1px solid ${colors.border}`,
	whiteSpace: 'nowrap' as const,
	backgroundColor: colors.surface,
}

const cellCss = {
	padding: `0.55rem ${spacing.md}`,
	borderBottom: `1px solid ${colors.border}`,
	verticalAlign: 'middle' as const,
	color: colors.text,
}

/**
 * Below 620px the same `<table>` becomes a list of cards — no duplicate DOM.
 * Cells carry their own label from `data-label`; the primary cell is the
 * card's heading and keeps none. Column `drop` priorities shed fields first;
 * when nowrap content still overflows the pane, the table scroller takes over
 * with horizontal overflow rather than clipping under `overflow: hidden`.
 */
const cardFallbackCss = {
	'@container (max-width: 620px)': {
		'& thead': { display: 'none' },
		'& table, & tbody, & tr, & td': { display: 'block', width: 'auto' },
		'& tbody tr[data-record-row]': { padding: 0 },
		'& tbody tr:not([data-record-row])': {
			borderBottom: `1px solid ${colors.border}`,
			padding: `0.55rem ${spacing.md}`,
		},
		'& td': {
			borderBottom: 0,
			padding: '0.1rem 0',
			display: 'flex',
			gap: spacing.sm,
			alignItems: 'baseline',
		},
		'& td::before': {
			content: 'attr(data-label)',
			flex: 'none',
			minWidth: '6.5rem',
			fontSize: '0.68rem',
			fontWeight: 700,
			letterSpacing: '0.07em',
			textTransform: 'uppercase',
			color: colors.textMuted,
		},
		'& td[data-primary]': {
			display: 'block',
			fontSize: typography.fontSize.base,
			marginBottom: '0.2rem',
		},
		'& td[data-primary]::before': { content: 'none' },
		'& tr[data-record-row] > td': { padding: 0 },
		'& tr[data-record-row] > td::before': { content: 'none' },
	},
}

const rowCss = {
	'&[data-selected]': {
		backgroundColor: colors.primarySoftest,
		boxShadow: `inset 3px 0 0 ${colors.primary}`,
	},
	[hoverMq]: {
		'&:not([data-selected]):hover': { backgroundColor: colors.background },
	},
}

const primaryCellCss = {
	...cellCss,
	fontWeight: 620,
	whiteSpace: 'nowrap' as const,
	// Let the cell shrink so sibling columns and the scroller can claim width
	// instead of the primary name forcing the whole table past the pane.
	maxWidth: '28rem',
	'@container (max-width: 620px)': {
		whiteSpace: 'normal',
		maxWidth: 'none',
	},
}

const rowLinkCss = {
	color: colors.text,
	textDecoration: 'none',
	'&:hover': { textDecoration: 'underline' },
}

const recordRowCss = {
	'& > td': {
		padding: 0,
		backgroundColor: colors.background,
		boxShadow: `inset 3px 0 0 ${colors.primary}`,
		borderBottom: `1px solid ${colors.border}`,
	},
}

const emptyCss = {
	margin: 0,
	padding: spacing.lg,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

/** Padding and rhythm for whatever a screen renders as its record. */
export const recordBodyCss = {
	padding: spacing.lg,
	display: 'grid',
	gap: spacing.lg,
	minWidth: 0,
}

const footerCss = {
	display: 'grid',
	padding: spacing.sm,
	borderTop: `1px solid ${colors.border}`,
}

/*
 * Toolbar controls. These came out of a sidebar that stacked a visible label
 * over each field and spent ~230px of height on three of them; on one row
 * they cost 48px, so the label becomes the control's accessible name.
 */

export function RecordTableSearch(
	handle: Handle<{
		label: string
		placeholder: string
		value: string
		onInput: (value: string) => void
	}>,
) {
	return () => (
		<input
			type="search"
			data-field-ring
			value={handle.props.value}
			placeholder={handle.props.placeholder}
			aria-label={handle.props.label}
			mix={[
				on('input', (event) =>
					handle.props.onInput((event.currentTarget as HTMLInputElement).value),
				),
				css({
					...getAuthInputCss(),
					flex: '1 1 12rem',
					minWidth: '7rem',
					width: 'auto',
				}),
			]}
		/>
	)
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

const visuallyHiddenCss = {
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

export function RecordTable(handle: Handle<RecordTableProps>) {
	function columnCss(column: RecordTableColumn) {
		return [
			column.align === 'end' ? numericCss : null,
			column.drop ? dropCss[column.drop] : null,
		]
	}

	return () => {
		const { mode, columns, rows, selectedId, onNavigate } = handle.props
		const selectable = mode !== 'none'
		// `expand` must not cap the list: the record renders inside the
		// scroller, so a max-height traps it in a nested scroll you have to
		// fight to read. `pane` and `none` keep the cap, which is what keeps
		// the record below reachable without a long scroll first.
		const capped = mode !== 'expand'
		// `expand` puts the record inside the row it belongs to, which only works
		// while that row is on screen. A deep link, a filter change, or paging
		// past the selection leaves a loaded record with no row to unfold under —
		// so it falls back to a pane below the table rather than disappearing.
		const orphanedRecord = Boolean(
			mode === 'expand' &&
			handle.props.record &&
			selectedId != null &&
			!rows.some((row) => row.id === selectedId),
		)

		const table = (
			<table aria-label={handle.props.ariaLabel} mix={css(tableCss)}>
				<thead>
					<tr>
						{columns.map((column) => (
							<th
								key={column.key}
								scope="col"
								mix={[css(headCellCss), ...columnCss(column)]}
							>
								{column.label}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.flatMap((row) => {
						const selected = selectable && row.id === selectedId
						const recordRowId = `${handle.id}-record-${row.id}`
						// A selected row with no record yet (still loading, or the detail
						// 404'd) renders no record row, so the link must not claim an
						// expanded region that is not in the DOM.
						const expanded = Boolean(
							selected && mode === 'expand' && handle.props.record,
						)

						return [
							<tr
								key={row.id}
								data-selected={selected ? 'true' : undefined}
								mix={css(rowCss)}
							>
								{columns.map((column) => {
									const content = row.cells[column.key] ?? null
									return (
										<td
											key={column.key}
											data-label={column.label}
											data-primary={column.primary ? 'true' : undefined}
											mix={[
												css(column.primary ? primaryCellCss : cellCss),
												...columnCss(column),
											]}
										>
											{column.primary && row.href ? (
												<a
													href={row.href}
													data-prevent-scroll-reset
													aria-current={selected ? 'true' : undefined}
													aria-expanded={
														mode === 'expand'
															? expanded
																? 'true'
																: 'false'
															: undefined
													}
													aria-controls={expanded ? recordRowId : undefined}
													mix={[
														css(rowLinkCss),
														on('click', (event: MouseEvent) => {
															if (!onNavigate) return
															if (
																!(
																	event.currentTarget instanceof
																	HTMLAnchorElement
																) ||
																!shouldRouterHandleClick(
																	event,
																	event.currentTarget,
																)
															) {
																return
															}
															onNavigate(row.id)
														}),
													]}
												>
													{content}
												</a>
											) : (
												content
											)}
										</td>
									)
								})}
							</tr>,
							expanded ? (
								<tr
									key={`${row.id}-record`}
									id={recordRowId}
									data-record-row="true"
									mix={css(recordRowCss)}
								>
									<td colSpan={columns.length}>{handle.props.record}</td>
								</tr>
							) : null,
						]
					})}
				</tbody>
			</table>
		)

		return (
			<section
				aria-label={handle.props.ariaLabel}
				aria-busy={handle.props.busy ? 'true' : undefined}
				mix={css(shellCss)}
			>
				<div mix={[css(paneCss), css(cardFallbackCss)]}>
					{handle.props.toolbar || handle.props.countLabel ? (
						<div mix={css(toolbarCss)}>
							{handle.props.toolbar}
							{handle.props.countLabel ? (
								<p
									mix={css(countCss)}
									data-busy={handle.props.busy ? 'true' : undefined}
								>
									{handle.props.countLabel}
								</p>
							) : null}
							{/*
							 * Out of flow, so announcing the refetch costs no layout.
							 * Polite because this narrates something the reader started;
							 * assertive would interrupt their own typing.
							 */}
							<span mix={css(visuallyHiddenCss)} aria-live="polite">
								{handle.props.busy ? 'Updating…' : ''}
							</span>
						</div>
					) : null}
					{rows.length === 0 ? (
						<p mix={css(emptyCss)}>
							{handle.props.emptyLabel ?? 'Nothing to show yet.'}
						</p>
					) : (
						<div
							mix={css({
								...tableScrollerCss,
								...(capped
									? {
											maxHeight:
												handle.props.scrollHeight ?? defaultScrollHeight,
											overflowY: 'auto' as const,
										}
									: null),
							})}
						>
							{table}
						</div>
					)}
					{handle.props.footer ? (
						<div mix={css(footerCss)}>{handle.props.footer}</div>
					) : null}
				</div>
				{(mode === 'pane' || orphanedRecord) && handle.props.record ? (
					<div mix={css(paneCss)}>{handle.props.record}</div>
				) : null}
			</section>
		)
	}
}
