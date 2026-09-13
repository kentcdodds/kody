/**
 * Display name used when `workflows.create` omits `workflowName` for inline
 * code. Package workflows fall back to the export path instead.
 */
export const inlineWorkflowNameFallback = 'inline-code'

function isInlineWorkflowNameFallback(name: string | null | undefined) {
	return name?.trim() === inlineWorkflowNameFallback
}

/**
 * Idempotency key shown under a list or heading name when that name is the
 * inline-code fallback. Empty keys stay hidden so a missing value does not
 * render a blank subtitle.
 */
export function inlineWorkflowNameSubtitle(
	displayedName: string,
	idempotencyKey: string | null | undefined,
) {
	if (!isInlineWorkflowNameFallback(displayedName)) return null
	const key = idempotencyKey?.trim()
	return key || null
}
