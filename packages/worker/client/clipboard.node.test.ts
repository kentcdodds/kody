import { expect, test, vi } from 'vitest'
import { writeClipboardText } from './clipboard.ts'

test('writeClipboardText uses clipboard API when available and falls back to execCommand', async () => {
	const writeText = vi.fn(async () => undefined)
	vi.stubGlobal('navigator', { clipboard: { writeText } })
	vi.stubGlobal('document', {
		createElement: () => {
			throw new Error('execCommand fallback should not run')
		},
	})

	await writeClipboardText('fork prompt')

	expect(writeText).toHaveBeenCalledWith('fork prompt')

	const execCommand = vi.fn(() => true)
	const textArea = {
		value: '',
		style: {} as CSSStyleDeclaration,
		select: vi.fn(),
		setAttribute: vi.fn(),
		remove: vi.fn(),
	}
	vi.stubGlobal('navigator', {})
	vi.stubGlobal('document', {
		createElement: vi.fn(() => textArea),
		body: { append: vi.fn() },
		execCommand,
	})

	await writeClipboardText('fork prompt')

	expect(textArea.value).toBe('fork prompt')
	expect(execCommand).toHaveBeenCalledWith('copy')
	expect(textArea.remove).toHaveBeenCalled()
})
