import { writeClipboardText } from '#client/clipboard.ts'
import {
	COPY_PROMPT_COPIED_TOOLTIP,
	COPY_PROMPT_SELECTOR,
} from '#universal/fork-outdated-copy-button.tsx'

export const FORK_OUTDATED_COPY_BUTTON_SELECTOR = COPY_PROMPT_SELECTOR

type CopyPromptButtonEl = {
	dataset: {
		copyText?: string
		copyTooltip?: string
		tooltipDismissed?: string
	}
	querySelector: (selector: string) => { textContent: string | null } | null
	contains: (node: Node) => boolean
}

function asCopyPromptButton(value: unknown): CopyPromptButtonEl | null {
	if (value == null || typeof value !== 'object') return null
	if (!('dataset' in value) || !('querySelector' in value)) return null
	return value as CopyPromptButtonEl
}

function findCopyPromptButton(event: Event) {
	const target = event.target
	if (target == null || typeof target !== 'object' || !('closest' in target)) {
		return null
	}
	const closest = target.closest
	if (typeof closest !== 'function') return null
	return asCopyPromptButton(closest.call(target, COPY_PROMPT_SELECTOR))
}

function setCopyPromptTooltip(button: CopyPromptButtonEl, text: string) {
	const tooltip = button.querySelector('[role="tooltip"]')
	if (tooltip) tooltip.textContent = text
}

export async function handleForkOutdatedCopyClick(event: Event) {
	const button = findCopyPromptButton(event)
	if (!button) return
	const text = button.dataset.copyText
	if (!text) return
	event.preventDefault()
	event.stopPropagation()
	try {
		await writeClipboardText(text)
		setCopyPromptTooltip(button, COPY_PROMPT_COPIED_TOOLTIP)
	} catch {
		setCopyPromptTooltip(button, 'Copy failed')
	}
}

export function handleForkOutdatedCopyPointerOut(event: Event) {
	const button = findCopyPromptButton(event)
	if (!button) return
	const related = 'relatedTarget' in event ? event.relatedTarget : null
	if (
		related != null &&
		typeof related === 'object' &&
		button.contains(related as Node)
	) {
		return
	}
	setCopyPromptTooltip(
		button,
		button.dataset.copyTooltip ?? COPY_PROMPT_COPIED_TOOLTIP,
	)
	delete button.dataset.tooltipDismissed
}

export function handleForkOutdatedCopyKeyDown(event: Event) {
	if (!('key' in event) || event.key !== 'Escape') return
	const button = findCopyPromptButton(event)
	if (!button) return
	button.dataset.tooltipDismissed = ''
}

export function handleForkOutdatedCopyFocusOut(event: Event) {
	const button = findCopyPromptButton(event)
	if (!button) return
	const related = 'relatedTarget' in event ? event.relatedTarget : null
	if (
		related != null &&
		typeof related === 'object' &&
		button.contains(related as Node)
	) {
		return
	}
	delete button.dataset.tooltipDismissed
}
