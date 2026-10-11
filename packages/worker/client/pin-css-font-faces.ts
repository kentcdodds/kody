/**
 * Chrome rebuilds its CSS font-face cache whenever the cascade changes in
 * certain ways — Remix StyleManager `@layer` inserts, the traverse scroll
 * adopted sheet, and head reconcile replacing the inline `@font-face` style.
 * Each rebuild creates new CSS-connected FontFace objects that start unloaded,
 * so `font-display: swap` repaints fallback fonts for a few frames on every
 * SPA navigation. Pinning the same faces as JS-created FontFace objects (which
 * are not CSS-connected and survive the rebuild) keeps the loaded face in
 * `document.fonts` so the swap never fires.
 */

type FontFaceLike = {
	readonly family: string
	readonly style: string
	readonly weight: string
	readonly stretch: string
	readonly unicodeRange: string
	readonly status: string
	load: () => Promise<FontFaceLike>
}

type FontFaceConstructor = new (
	family: string,
	source: string,
	descriptors?: Record<string, string>,
) => FontFaceLike

type FontFaceSetLike = {
	add: (face: FontFaceLike) => unknown
	addEventListener: (type: string, listener: () => void) => void
	[Symbol.iterator]: () => Iterator<FontFaceLike>
}

type FontFaceRuleStyle = {
	getPropertyValue: (property: string) => string
}

type FontFaceRuleLike = {
	readonly type: number
	readonly style: FontFaceRuleStyle
}

type StyleSheetLike = {
	readonly href: string | null
	readonly cssRules: ArrayLike<{ readonly type: number }>
}

type PinFontFacesDocument = {
	readonly baseURI: string
	readonly fonts: FontFaceSetLike
	readonly styleSheets: ArrayLike<StyleSheetLike>
}

export type PinCssFontFacesHost = {
	FontFace?: FontFaceConstructor
	document?: PinFontFacesDocument | null
}

const FONT_FACE_RULE = 5

// Module-level so repeat calls (e.g. after hydration re-entry) and Chrome's
// font-face cache rebuilds never create duplicate twins.
const twins = new WeakSet<FontFaceLike>()
const pinnedKeys = new Set<string>()

function stripQuotes(value: string): string {
	const trimmed = value.trim()
	return trimmed.replace(/^(['"])(.*)\1$/, '$2').trim()
}

function resolveSrcUrls(src: string, base: string): string {
	return src.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g, (_match, _quote, url) => {
		try {
			return `url("${new URL(url, base).href}")`
		} catch {
			return `url("${url}")`
		}
	})
}

function fontFaceKey(face: FontFaceLike): string {
	return [
		// Chrome quotes family on JS-created FontFaces but not CSS-connected
		// ones; normalize so twins and CSS faces share a key.
		stripQuotes(face.family),
		face.style,
		face.weight,
		face.stretch,
		face.unicodeRange,
	].join('|')
}

function cssFontFaceRules(
	doc: PinFontFacesDocument,
): Array<{ rule: FontFaceRuleLike; href: string | null }> {
	const rules: Array<{ rule: FontFaceRuleLike; href: string | null }> = []
	for (const sheet of Array.from(doc.styleSheets)) {
		let cssRules: ArrayLike<{ readonly type: number }>
		try {
			// Cross-origin sheets throw on cssRules access; skip them.
			cssRules = sheet.cssRules
		} catch {
			continue
		}
		for (const rule of Array.from(cssRules)) {
			if (rule.type === FONT_FACE_RULE) {
				rules.push({ rule: rule as FontFaceRuleLike, href: sheet.href })
			}
		}
	}
	return rules
}

export function pinCssFontFaces(
	host: PinCssFontFacesHost | undefined = typeof globalThis === 'undefined'
		? undefined
		: (globalThis as unknown as PinCssFontFacesHost),
): void {
	const FontFaceCtor = host?.FontFace
	const doc = host?.document
	if (typeof FontFaceCtor !== 'function' || !doc?.fonts) return
	const fonts = doc.fonts

	const pending = new Map<string, FontFaceLike>()

	for (const { rule, href } of cssFontFaceRules(doc)) {
		const family = stripQuotes(rule.style.getPropertyValue('font-family'))
		const src = rule.style.getPropertyValue('src')
		if (!family || !src) continue
		const descriptors: Record<string, string> = {}
		const entries: Array<[string, string]> = [
			['style', rule.style.getPropertyValue('font-style')],
			['weight', rule.style.getPropertyValue('font-weight')],
			['stretch', rule.style.getPropertyValue('font-stretch')],
			['unicodeRange', rule.style.getPropertyValue('unicode-range')],
			['display', rule.style.getPropertyValue('font-display')],
		]
		for (const [key, value] of entries) {
			const trimmed = value.trim()
			if (trimmed) descriptors[key] = trimmed
		}
		const twin = new FontFaceCtor(
			family,
			resolveSrcUrls(src, href ?? doc.baseURI),
			descriptors,
		)
		const key = fontFaceKey(twin)
		if (!pending.has(key) && !pinnedKeys.has(key)) pending.set(key, twin)
	}

	function cssFaceStatus(key: string): string | undefined {
		for (const face of fonts) {
			if (!twins.has(face) && fontFaceKey(face) === key) return face.status
		}
		return undefined
	}

	function pin(key: string, twin: FontFaceLike) {
		pinnedKeys.add(key)
		pending.delete(key)
		twin
			.load()
			.then((loaded) => {
				twins.add(loaded)
				fonts.add(loaded)
			})
			.catch(() => {
				// Let a later loadingdone retry the pin.
				pinnedKeys.delete(key)
				pending.set(key, twin)
			})
	}

	function tryPin(allowed: ReadonlySet<string>) {
		for (const [key, twin] of pending) {
			const status = cssFaceStatus(key)
			if (status && allowed.has(status)) {
				pin(key, twin)
			}
		}
	}

	// Pin only faces Chrome has already used; unused unicode-range/italic
	// faces stay lazy until their CSS-connected face loads.
	tryPin(new Set(['loaded', 'loading']))
	fonts.addEventListener('loadingdone', () => tryPin(new Set(['loaded'])))
}
