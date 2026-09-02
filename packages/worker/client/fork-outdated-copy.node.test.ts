import { expect, test, vi } from 'vitest'
import {
	handleForkOutdatedCopyClick,
	handleForkOutdatedCopyFocusOut,
	handleForkOutdatedCopyKeyDown,
	handleForkOutdatedCopyPointerOut,
} from './fork-outdated-copy.ts'

test('fork outdated click copies the prompt and swaps the tooltip to Copied', async () => {
	const writeText = vi.fn(async () => undefined)
	vi.stubGlobal('navigator', { clipboard: { writeText } })

	const tooltip = { textContent: 'Click to copy an update prompt' }
	const button = {
		dataset: {
			copyText: 'absorb these listing changes',
			copyTooltip: 'Click to copy an update prompt',
		},
		querySelector: (selector: string) =>
			selector === '[role="tooltip"]' ? tooltip : null,
		contains: () => false,
	}
	const event = {
		target: {
			closest: (selector: string) =>
				selector === '[data-copy-prompt]' ? button : null,
		},
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
	}

	await handleForkOutdatedCopyClick(event as unknown as Event)

	expect(event.preventDefault).toHaveBeenCalled()
	expect(event.stopPropagation).toHaveBeenCalled()
	expect(writeText).toHaveBeenCalledWith('absorb these listing changes')
	expect(tooltip.textContent).toBe('Copied')

	handleForkOutdatedCopyPointerOut({
		target: event.target,
		relatedTarget: null,
	} as unknown as Event)
	expect(tooltip.textContent).toBe('Click to copy an update prompt')
})

test('Escape dismisses the copy-prompt tooltip while the button stays focused', () => {
	const button = {
		dataset: {
			copyText: 'absorb these listing changes',
			copyTooltip: 'Click to copy an update prompt',
		},
		querySelector: () => null,
		contains: () => false,
	}
	handleForkOutdatedCopyKeyDown({
		key: 'Escape',
		target: {
			closest: (selector: string) =>
				selector === '[data-copy-prompt]' ? button : null,
		},
	} as unknown as Event)
	expect(button.dataset.tooltipDismissed).toBe('')

	handleForkOutdatedCopyFocusOut({
		target: {
			closest: (selector: string) =>
				selector === '[data-copy-prompt]' ? button : null,
		},
		relatedTarget: null,
	} as unknown as Event)
	expect(button.dataset.tooltipDismissed).toBeUndefined()
})
