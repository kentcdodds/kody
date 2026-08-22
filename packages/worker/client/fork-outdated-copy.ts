import { writeClipboardText } from '#client/clipboard.ts'
import {
	FORK_OUTDATED_COPIED_TOOLTIP,
	FORK_OUTDATED_COPY_TOOLTIP,
} from '#universal/fork-outdated-copy-button.tsx'

export const FORK_OUTDATED_COPY_BUTTON_SELECTOR = '[data-fork-outdated-copy]'

type ForkOutdatedCopyButtonEl = {
	dataset: { copyText?: string }
	querySelector: (selector: string) => { textContent: string | null } | null
	contains: (node: Node) => boolean
}

function asForkOutdatedCopyButton(
	value: unknown,
): ForkOutdatedCopyButtonEl | null {
	if (value == null || typeof value !== 'object') return null
	if (!('dataset' in value) || !('querySelector' in value)) return null
	return value as ForkOutdatedCopyButtonEl
}

function findForkOutdatedCopyButton(event: Event) {
	const target = event.target
	if (target == null || typeof target !== 'object' || !('closest' in target)) {
		return null
	}
	const closest = target.closest
	if (typeof closest !== 'function') return null
	return asForkOutdatedCopyButton(
		closest.call(target, FORK_OUTDATED_COPY_BUTTON_SELECTOR),
	)
}

function setForkOutdatedTooltip(
	button: ForkOutdatedCopyButtonEl,
	text: string,
) {
	const tooltip = button.querySelector('[role="tooltip"]')
	if (tooltip) tooltip.textContent = text
}

export async function handleForkOutdatedCopyClick(event: Event) {
	const button = findForkOutdatedCopyButton(event)
	if (!button) return
	const text = button.dataset.copyText
	if (!text) return
	event.preventDefault()
	event.stopPropagation()
	try {
		await writeClipboardText(text)
		setForkOutdatedTooltip(button, FORK_OUTDATED_COPIED_TOOLTIP)
	} catch {
		setForkOutdatedTooltip(button, 'Copy failed')
	}
}

export function handleForkOutdatedCopyPointerOut(event: Event) {
	const button = findForkOutdatedCopyButton(event)
	if (!button) return
	const related = 'relatedTarget' in event ? event.relatedTarget : null
	if (
		related != null &&
		typeof related === 'object' &&
		button.contains(related as Node)
	) {
		return
	}
	setForkOutdatedTooltip(button, FORK_OUTDATED_COPY_TOOLTIP)
}
