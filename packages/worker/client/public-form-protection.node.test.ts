import { readFileSync } from 'node:fs'
import { expect, test, vi } from 'vitest'
import {
	readPublicFormProtection,
	renderTurnstileWidgets,
	resetTurnstileWidgets,
	turnstileWidgetHeightPx,
	turnstileWidgetWidthPx,
} from '#client/public-form-protection.ts'

test('styles.css reserves the managed Turnstile box and centers it on the landing waitlist', () => {
	const css = readFileSync(
		new URL('../public/styles.css', import.meta.url),
		'utf8',
	)
	const hostBlock = css.match(/\.kody-turnstile\s*\{([^}]+)\}/)?.[1]
	expect(hostBlock).toContain(`height: ${turnstileWidgetHeightPx}px`)
	expect(hostBlock).toContain(`min-height: ${turnstileWidgetHeightPx}px`)
	expect(hostBlock).toContain(`width: min(${turnstileWidgetWidthPx}px, 100%)`)
	expect(css).toMatch(
		/\.landing-waitlist \.kody-turnstile\s*\{[^}]*justify-self:\s*center/s,
	)
})

type FakeContainer = HTMLElement & {
	dataset: DOMStringMap & {
		turnstileRendered?: string
		turnstileWidgetId?: string
	}
	childElementCount: number
	querySelector: ReturnType<typeof vi.fn>
}

function createContainer(options: {
	rendered?: boolean
	childElementCount?: number
	widgetId?: string
}): FakeContainer {
	const dataset: DOMStringMap & {
		turnstileRendered?: string
		turnstileWidgetId?: string
	} = {}
	if (options.rendered) dataset.turnstileRendered = 'true'
	if (options.widgetId) dataset.turnstileWidgetId = options.widgetId
	return {
		dataset,
		childElementCount: options.childElementCount ?? 0,
		querySelector: vi.fn(),
	} as unknown as FakeContainer
}

function createShadowContainer(options: {
	rendered?: boolean
	lightChildElementCount?: number
	mountChildElementCount?: number
	widgetId?: string
}) {
	const container = createContainer({
		rendered: options.rendered,
		childElementCount: options.lightChildElementCount ?? 0,
		widgetId: options.widgetId,
	})
	const mount = {
		childElementCount: options.mountChildElementCount ?? 0,
		querySelector: vi.fn(),
	}
	const shadowRoot = {
		querySelector: (selector: string) =>
			selector === '[data-turnstile-mount]' ? mount : null,
	}
	return Object.assign(container, {
		shadowRoot,
		attachShadow: vi.fn(() => shadowRoot),
		mount,
	})
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
		querySelectorAll: vi.fn(() => [orphan, live, zombie]),
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

test('resetTurnstileWidgets resets a live shadow mount after a light-DOM wipe', () => {
	const liveShadow = createShadowContainer({
		rendered: true,
		lightChildElementCount: 0,
		mountChildElementCount: 1,
		widgetId: 'live-widget',
	})
	const reset = vi.fn()
	const remove = vi.fn()

	vi.stubGlobal('document', {
		querySelectorAll: vi.fn(() => [liveShadow]),
	})
	vi.stubGlobal('window', { turnstile: { reset, remove } })

	expect(() => resetTurnstileWidgets()).not.toThrow()
	expect(reset).toHaveBeenCalledWith(liveShadow.mount)
	expect(remove).not.toHaveBeenCalled()
	expect(liveShadow.dataset.turnstileRendered).toBe('true')
	expect(liveShadow.dataset.turnstileWidgetId).toBe('live-widget')

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
		querySelectorAll: vi.fn(() => [orphan, live, fresh]),
	})
	vi.stubGlobal('window', { turnstile: { render, remove } })

	await renderTurnstileWidgets('site-key')

	expect(remove).toHaveBeenCalledWith(orphan)
	expect(render).toHaveBeenCalledTimes(2)
	expect(render).toHaveBeenCalledWith(orphan, {
		sitekey: 'site-key',
		'response-field-name': 'turnstileToken',
		'error-callback': expect.any(Function),
	})
	expect(render).toHaveBeenCalledWith(fresh, {
		sitekey: 'site-key',
		'response-field-name': 'turnstileToken',
		'error-callback': expect.any(Function),
	})
	expect(render).not.toHaveBeenCalledWith(live, expect.anything())
	expect(orphan.dataset.turnstileRendered).toBe('true')
	expect(fresh.dataset.turnstileRendered).toBe('true')
	expect(live.dataset.turnstileRendered).toBe('true')
	const renderOptions = render.mock.calls[0]?.[1] as {
		'error-callback': (code: number) => boolean
	}
	expect(renderOptions['error-callback'](300010)).toBe(true)
	expect(orphan.dataset.turnstileWidgetId).toBe('widget-id')
	expect(fresh.dataset.turnstileWidgetId).toBe('widget-id')

	vi.unstubAllGlobals()
})

test('renderTurnstileWidgets keeps a live shadow mount after a light-DOM wipe', async () => {
	const liveShadow = createShadowContainer({
		rendered: true,
		lightChildElementCount: 0,
		mountChildElementCount: 1,
		widgetId: 'live-widget',
	})
	const wipedShadow = createShadowContainer({
		rendered: true,
		lightChildElementCount: 0,
		mountChildElementCount: 0,
	})
	const render = vi.fn((mount: { childElementCount: number }) => {
		mount.childElementCount = 1
		return 'remounted-widget'
	})
	const remove = vi.fn()

	vi.stubGlobal('document', {
		querySelectorAll: vi.fn(() => [liveShadow, wipedShadow]),
	})
	vi.stubGlobal('window', { turnstile: { render, remove } })

	await renderTurnstileWidgets('site-key')

	expect(remove).not.toHaveBeenCalledWith(liveShadow)
	expect(remove).not.toHaveBeenCalledWith(liveShadow.mount)
	expect(render).not.toHaveBeenCalledWith(liveShadow, expect.anything())
	expect(render).not.toHaveBeenCalledWith(liveShadow.mount, expect.anything())
	expect(remove).toHaveBeenCalledWith(wipedShadow.mount)
	expect(render).toHaveBeenCalledTimes(1)
	expect(render).toHaveBeenCalledWith(wipedShadow.mount, {
		sitekey: 'site-key',
		'response-field-name': 'turnstileToken',
		'error-callback': expect.any(Function),
	})
	expect(liveShadow.dataset.turnstileRendered).toBe('true')
	expect(liveShadow.dataset.turnstileWidgetId).toBe('live-widget')
	expect(wipedShadow.dataset.turnstileRendered).toBe('true')
	expect(wipedShadow.dataset.turnstileWidgetId).toBe('remounted-widget')

	vi.unstubAllGlobals()
})

test('readPublicFormProtection falls back to Turnstile getResponse in a form scope', () => {
	const other = createContainer({
		rendered: true,
		widgetId: 'other-widget',
	})
	const target = createContainer({
		rendered: true,
		widgetId: 'target-widget',
	})
	const form = {
		querySelectorAll: vi.fn((selector: string) => {
			expect(selector).toBe('.kody-turnstile')
			return [target]
		}),
	}
	const getResponse = vi.fn((widgetId: string) => {
		if (widgetId === 'target-widget') return 'solved-token'
		if (widgetId === 'other-widget') return 'wrong-token'
		return ''
	})

	vi.stubGlobal('document', {
		querySelectorAll: vi.fn(() => [other, target]),
	})
	vi.stubGlobal('window', { turnstile: { getResponse } })

	const formData = new FormData()
	formData.set('kody_hp', '')
	expect(
		readPublicFormProtection(formData, form as unknown as ParentNode),
	).toEqual({
		kody_hp: '',
		turnstileToken: 'solved-token',
	})
	expect(getResponse).toHaveBeenCalledWith('target-widget')
	expect(getResponse).not.toHaveBeenCalledWith('other-widget')

	formData.set('turnstileToken', 'field-token')
	expect(
		readPublicFormProtection(formData, form as unknown as ParentNode),
	).toEqual({
		kody_hp: '',
		turnstileToken: 'field-token',
	})

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

test('renderTurnstileWidgets soft-fails when the Turnstile script fails to load', async () => {
	const listeners = new Map<string, EventListener>()
	const script = {
		async: false,
		defer: false,
		src: '',
		dataset: {} as DOMStringMap & { kodyTurnstile?: string },
		addEventListener(type: string, handler: EventListener) {
			listeners.set(type, handler)
		},
		remove: vi.fn(),
	}

	vi.stubGlobal('window', {})
	vi.stubGlobal('document', {
		querySelector: vi.fn(() => null),
		querySelectorAll: vi.fn(() => []),
		createElement: vi.fn(() => script),
		head: {
			append() {
				listeners.get('error')?.(new Event('error'))
			},
		},
	})

	await expect(renderTurnstileWidgets('site-key')).resolves.toBeUndefined()
	expect(script.remove).toHaveBeenCalled()

	vi.unstubAllGlobals()
})
