import { expect, test, vi } from 'vitest'
import {
	renderTurnstileWidgets,
	resetTurnstileWidgets,
	turnstileWidgetClassName,
} from '#client/public-form-protection.ts'

type FakeContainer = HTMLElement & {
	dataset: DOMStringMap & { turnstileRendered?: string }
	childElementCount: number
	querySelector: ReturnType<typeof vi.fn>
}

function createContainer(options: {
	rendered?: boolean
	childElementCount?: number
}): FakeContainer {
	const dataset: DOMStringMap & { turnstileRendered?: string } = {}
	if (options.rendered) dataset.turnstileRendered = 'true'
	return {
		dataset,
		childElementCount: options.childElementCount ?? 0,
		querySelector: vi.fn(),
	} as unknown as FakeContainer
}

test('resetTurnstileWidgets clears orphaned hosts instead of throwing', () => {
	const orphan = createContainer({ rendered: true, childElementCount: 0 })
	const live = createContainer({ rendered: true, childElementCount: 2 })
	const zombie = createContainer({ rendered: true, childElementCount: 1 })
	const reset = vi.fn((container: FakeContainer) => {
		if (container === zombie) {
			throw new Error(
				'[Cloudflare Turnstile] Nothing to reset found for provided container.',
			)
		}
	})
	const remove = vi.fn()

	vi.stubGlobal('document', {
		querySelectorAll: vi.fn((selector: string) => {
			expect(selector).toBe(
				`.${turnstileWidgetClassName}[data-turnstile-rendered]`,
			)
			return [orphan, live, zombie]
		}),
	})
	vi.stubGlobal('window', { turnstile: { reset, remove } })

	expect(() => resetTurnstileWidgets()).not.toThrow()
	expect(orphan.dataset.turnstileRendered).toBeUndefined()
	expect(zombie.dataset.turnstileRendered).toBeUndefined()
	expect(remove).toHaveBeenCalledWith(orphan)
	expect(remove).toHaveBeenCalledWith(zombie)
	expect(reset).toHaveBeenCalledWith(live)
	expect(reset).toHaveBeenCalledWith(zombie)
	expect(live.dataset.turnstileRendered).toBe('true')

	vi.unstubAllGlobals()
})

test('renderTurnstileWidgets remounts hosts whose children were wiped by a re-render', async () => {
	const orphan = createContainer({ rendered: true, childElementCount: 0 })
	const live = createContainer({ rendered: true, childElementCount: 1 })
	const fresh = createContainer({ rendered: false, childElementCount: 0 })
	const render = vi.fn((container: FakeContainer) => {
		container.childElementCount = 1
		return 'widget-id'
	})
	const remove = vi.fn()

	vi.stubGlobal('document', {
		querySelectorAll: vi.fn((selector: string) => {
			expect(selector).toBe(`.${turnstileWidgetClassName}`)
			return [orphan, live, fresh]
		}),
	})
	vi.stubGlobal('window', { turnstile: { render, remove } })

	await renderTurnstileWidgets('site-key')

	expect(remove).toHaveBeenCalledWith(orphan)
	expect(render).toHaveBeenCalledTimes(2)
	expect(render).toHaveBeenCalledWith(orphan, {
		sitekey: 'site-key',
		'response-field-name': 'turnstileToken',
	})
	expect(render).toHaveBeenCalledWith(fresh, {
		sitekey: 'site-key',
		'response-field-name': 'turnstileToken',
	})
	expect(render).not.toHaveBeenCalledWith(live, expect.anything())
	expect(orphan.dataset.turnstileRendered).toBe('true')
	expect(fresh.dataset.turnstileRendered).toBe('true')
	expect(live.dataset.turnstileRendered).toBe('true')

	vi.unstubAllGlobals()
})

test('renderTurnstileWidgets does not leave the rendered marker when render throws', async () => {
	const container = createContainer({ rendered: false, childElementCount: 0 })
	const render = vi.fn(() => {
		throw new Error('render failed')
	})

	vi.stubGlobal('document', {
		querySelectorAll: vi.fn(() => [container]),
	})
	vi.stubGlobal('window', { turnstile: { render } })

	await expect(renderTurnstileWidgets('site-key')).rejects.toThrow(
		'render failed',
	)
	expect(container.dataset.turnstileRendered).toBeUndefined()

	vi.unstubAllGlobals()
})
