import { css, type RemixNode } from 'remix/ui'
import {
	recordCellClamp,
	recordStampCss,
} from '#client/routes/record-table.tsx'
import { inlineWorkflowNameSubtitle } from '#universal/workflow-display.ts'
import { colors, typography } from '#universal/styles/tokens.ts'

const clampedNameCss = css(recordCellClamp(28))

const headingSubtitleCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

export function renderWorkflowNameCell(input: {
	name: string
	idempotencyKey?: string | null
}): RemixNode {
	const subtitle = inlineWorkflowNameSubtitle(input.name, input.idempotencyKey)
	return (
		<span mix={css({ display: 'grid', gap: '0.125rem', minWidth: 0 })}>
			<span mix={clampedNameCss}>{input.name}</span>
			{subtitle ? <span mix={css(recordStampCss)}>{subtitle}</span> : null}
		</span>
	)
}

export function renderInlineWorkflowNameSubtitle(input: {
	displayedName: string
	idempotencyKey?: string | null
}): RemixNode {
	const subtitle = inlineWorkflowNameSubtitle(
		input.displayedName,
		input.idempotencyKey,
	)
	if (!subtitle) return null
	return <p mix={css(headingSubtitleCss)}>{subtitle}</p>
}
