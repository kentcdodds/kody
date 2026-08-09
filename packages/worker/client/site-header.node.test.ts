import { expect, test, vi } from 'vitest'
import { dismissOpenPopoverPanel } from './site-header.tsx'

test('dismissOpenPopoverPanel skips matches when hidePopover is unavailable', () => {
	const matches = vi.fn(() => {
		throw new SyntaxError(
			"Failed to execute 'matches' on 'Element': ':popover-open' is not a valid selector.",
		)
	})
	const panel = { matches } as unknown as HTMLElement

	expect(() => dismissOpenPopoverPanel(panel)).not.toThrow()
	expect(matches).not.toHaveBeenCalled()
})

test('dismissOpenPopoverPanel hides an open popover panel', () => {
	const hidePopover = vi.fn()
	const panel = {
		hidePopover,
		matches: vi.fn((selector: string) => selector === ':popover-open'),
	} as unknown as HTMLElement

	dismissOpenPopoverPanel(panel)

	expect(panel.matches).toHaveBeenCalledWith(':popover-open')
	expect(hidePopover).toHaveBeenCalledOnce()
})

test('dismissOpenPopoverPanel no-ops when the popover is closed', () => {
	const hidePopover = vi.fn()
	const panel = {
		hidePopover,
		matches: vi.fn(() => false),
	} as unknown as HTMLElement

	dismissOpenPopoverPanel(panel)

	expect(hidePopover).not.toHaveBeenCalled()
})
