import { expect, test, vi } from 'vitest'
import {
	pinCssFontFaces,
	type PinCssFontFacesHost,
} from './pin-css-font-faces.ts'

class FakeFontFace {
	family: string
	source: string
	style: string
	weight: string
	stretch: string
	unicodeRange: string
	display: string
	status: 'unloaded' | 'loading' | 'loaded' | 'error' = 'unloaded'
	loads = 0

	constructor(
		family: string,
		source: string,
		descriptors: Record<string, string> = {},
	) {
		this.family = family
		this.source = source
		this.style = descriptors.style ?? 'normal'
		this.weight = descriptors.weight ?? 'normal'
		this.stretch = descriptors.stretch ?? 'normal'
		this.unicodeRange = descriptors.unicodeRange ?? 'U+0-10FFFF'
		this.display = descriptors.display ?? 'auto'
	}

	async load(): Promise<FakeFontFace> {
		this.loads += 1
		this.status = 'loaded'
		return this
	}
}

class FakeFontFaceSet extends Set<FakeFontFace> {
	private listeners: Array<() => void> = []
	addEventListener(_type: string, listener: () => void) {
		this.listeners.push(listener)
	}
	fireLoadingDone() {
		for (const listener of this.listeners) listener()
	}
}

function fontFaceRule(properties: Record<string, string>) {
	return {
		type: 5,
		style: {
			getPropertyValue(name: string) {
				return properties[name] ?? ''
			},
		},
	}
}

function createHost(rules: Array<unknown>, options: { href?: string } = {}) {
	const fonts = new FakeFontFaceSet()
	const host: PinCssFontFacesHost = {
		FontFace: FakeFontFace,
		document: {
			baseURI: 'https://kody.codes/pricing',
			fonts: fonts as never,
			styleSheets: [{ href: options.href ?? null, cssRules: rules }] as never,
		},
	}
	return { host, fonts }
}

function twinFaces(fonts: FakeFontFaceSet) {
	return [...fonts].filter((face) => face.loads > 0)
}

test('pins a loaded CSS face with absolute src and matching descriptors', async () => {
	const cssFace = new FakeFontFace(
		'Inter',
		'url("https://kody.codes/fonts/inter.woff2") format("woff2")',
		{ weight: '400', unicodeRange: 'U+0-FF' },
	)
	cssFace.status = 'loaded'
	const { host, fonts } = createHost([
		fontFaceRule({
			'font-family': '"Inter"',
			src: 'url(/fonts/inter.woff2) format("woff2")',
			'font-weight': '400',
			'unicode-range': 'U+0-FF',
		}),
	])
	fonts.add(cssFace)

	pinCssFontFaces(host)
	await vi.waitFor(() => expect(twinFaces(fonts)).toHaveLength(1))

	const twin = twinFaces(fonts)[0]!
	expect(twin).not.toBe(cssFace)
	expect(twin.family).toBe('Inter')
	expect(twin.source).toBe(
		'url("https://kody.codes/fonts/inter.woff2") format("woff2")',
	)
	expect(twin.weight).toBe('400')
	expect(twin.unicodeRange).toBe('U+0-FF')
})

test('does not pin an unloaded CSS face until it loads and loadingdone fires', async () => {
	const cssFace = new FakeFontFace('LazyFont', 'url("x.woff2")', {
		weight: '400',
	})
	const { host, fonts } = createHost([
		fontFaceRule({
			'font-family': 'LazyFont',
			src: 'url(x.woff2)',
			'font-weight': '400',
		}),
	])
	fonts.add(cssFace)

	pinCssFontFaces(host)
	await Promise.resolve()
	expect(twinFaces(fonts)).toHaveLength(0)

	cssFace.status = 'loaded'
	fonts.fireLoadingDone()
	await vi.waitFor(() => expect(twinFaces(fonts)).toHaveLength(1))
})

test('repeated loadingdone, second call, and recreated CSS faces still produce one twin per key', async () => {
	const rule = fontFaceRule({
		'font-family': 'DupFont',
		src: 'url(x.woff2)',
		'font-weight': '400',
	})
	const { host, fonts } = createHost([rule])
	const cssFace = new FakeFontFace('DupFont', 'url("x.woff2")', {
		weight: '400',
	})
	cssFace.status = 'loaded'
	fonts.add(cssFace)

	pinCssFontFaces(host)
	await vi.waitFor(() => expect(twinFaces(fonts)).toHaveLength(1))

	fonts.fireLoadingDone()
	pinCssFontFaces(host)
	// Chrome rebuilds the CSS-connected face; the key stays the same.
	fonts.delete(cssFace)
	const rebuilt = new FakeFontFace('DupFont', 'url("x.woff2")', {
		weight: '400',
	})
	rebuilt.status = 'loaded'
	fonts.add(rebuilt)
	fonts.fireLoadingDone()
	await Promise.resolve()

	expect(twinFaces(fonts)).toHaveLength(1)
})

test('is a no-op when FontFace is undefined', () => {
	const fonts = new FakeFontFaceSet()
	const host: PinCssFontFacesHost = {
		document: {
			baseURI: 'https://kody.codes/',
			fonts: fonts as never,
			styleSheets: [],
		},
	}
	expect(() => pinCssFontFaces(host)).not.toThrow()
	expect(fonts.size).toBe(0)
})

test('skips sheets whose cssRules getter throws', async () => {
	const cssFace = new FakeFontFace('ThrowSheetFont', 'url("x.woff2")')
	cssFace.status = 'loaded'
	const fonts = new FakeFontFaceSet()
	fonts.add(cssFace)
	const throwingSheet = {
		href: 'https://cdn.example.com/x.css',
		get cssRules(): never {
			throw new DOMException('SecurityError')
		},
	}
	const goodSheet = {
		href: null,
		cssRules: [
			fontFaceRule({ 'font-family': 'ThrowSheetFont', src: 'url(x.woff2)' }),
		],
	}
	const host: PinCssFontFacesHost = {
		FontFace: FakeFontFace,
		document: {
			baseURI: 'https://kody.codes/',
			fonts: fonts as never,
			styleSheets: [throwingSheet, goodSheet] as never,
		},
	}

	pinCssFontFaces(host)
	await vi.waitFor(() => expect(twinFaces(fonts)).toHaveLength(1))
})
