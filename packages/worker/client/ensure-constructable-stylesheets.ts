/**
 * Remix UI's `createStyleManager` calls `new CSSStyleSheet()` and pushes onto
 * `document.adoptedStyleSheets`. Constructable stylesheets shipped in Safari
 * 16.4 / iOS 16.4; older WebKit throws `TypeError: Illegal constructor`
 * (KODY-CLOUDFLARE-63 on `/guides/how-kody-works`). Install a `<style>`-backed
 * polyfill before `run()` so client css-mixin inserts still apply.
 *
 * This is not a full Constructable Stylesheets polyfill (no ShadowRoot
 * adoption, no `replace` / `replaceSync`). It covers the Remix StyleManager
 * surface: construct, `adoptedStyleSheets.push` / assign, `insertRule`,
 * `deleteRule`, and `cssRules`.
 */

export type ConstructableStyleSheetLike = {
	readonly cssRules: { readonly length: number }
	insertRule: (rule: string, index?: number) => number
	deleteRule: (index: number) => void
}

export type ConstructableStylesheetsDocument = {
	createElement: (tagName: string) => {
		sheet: ConstructableStyleSheetLike | null
		appendChild: (node: unknown) => unknown
		remove: () => void
		readonly isConnected: boolean
	}
	createTextNode: (data: string) => unknown
	head?: { appendChild: (node: unknown) => unknown } | null
	documentElement?: { appendChild: (node: unknown) => unknown } | null
	adoptedStyleSheets?: Array<ConstructableStyleSheetLike>
}

export type ConstructableStylesheetsHost = {
	CSSStyleSheet?: unknown
	document?: ConstructableStylesheetsDocument | null
}

type PolyfilledStyleElement = ReturnType<
	ConstructableStylesheetsDocument['createElement']
>

type PolyfilledStyleSheet = ConstructableStyleSheetLike & {
	_style: PolyfilledStyleElement
	_attach: (doc: ConstructableStylesheetsDocument) => void
	_detach: () => void
}

function canConstructStyleSheet(Ctor: unknown): boolean {
	if (typeof Ctor !== 'function') return false
	try {
		Reflect.construct(Ctor as new () => unknown, [])
		return true
	} catch {
		return false
	}
}

function supportsConstructableStylesheets(
	host: ConstructableStylesheetsHost,
): boolean {
	const doc = host.document
	if (!doc) return false
	return (
		canConstructStyleSheet(host.CSSStyleSheet) && 'adoptedStyleSheets' in doc
	)
}

function appendStyleElement(
	doc: ConstructableStylesheetsDocument,
	style: PolyfilledStyleElement,
): void {
	const parent = doc.head ?? doc.documentElement
	// Always appendChild: a connected node is moved without disconnecting, so
	// CSSOM rules from insertRule survive reorder (unlike remove + reinsert).
	parent?.appendChild(style)
}

function requireLiveSheet(
	style: PolyfilledStyleElement,
	operation: string,
): ConstructableStyleSheetLike {
	const live = style.sheet
	if (!live) {
		throw new TypeError(
			`CSSStyleSheet ${operation} is unavailable until the sheet is adopted`,
		)
	}
	return live
}

function createPolyfilledStyleSheet(
	doc: ConstructableStylesheetsDocument,
): PolyfilledStyleSheet {
	const style = doc.createElement('style')
	// Non-empty text node so older engines expose `.sheet` once connected.
	style.appendChild(doc.createTextNode(''))

	return {
		_style: style,
		_attach(ownerDoc) {
			appendStyleElement(ownerDoc, style)
		},
		_detach() {
			style.remove()
		},
		get cssRules() {
			return requireLiveSheet(style, 'cssRules').cssRules
		},
		insertRule(rule, index = 0) {
			return requireLiveSheet(style, 'insertRule').insertRule(rule, index)
		},
		deleteRule(index) {
			requireLiveSheet(style, 'deleteRule').deleteRule(index)
		},
	}
}

function syncAdoptedStyleSheets(
	doc: ConstructableStylesheetsDocument,
	previous: Array<PolyfilledStyleSheet>,
	next: Array<PolyfilledStyleSheet>,
): void {
	// Drop sheets that left the list. Retained sheets stay connected so
	// insertRule CSSOM state survives; appendChild below only moves them.
	for (const sheet of previous) {
		if (!next.includes(sheet)) {
			sheet._detach()
		}
	}
	for (const sheet of next) {
		sheet._attach(doc)
	}
}

function wirePush(
	sheets: Array<PolyfilledStyleSheet>,
	onMutate: () => void,
): void {
	sheets.push = (...items: Array<PolyfilledStyleSheet>) => {
		const length = Array.prototype.push.apply(sheets, items)
		onMutate()
		return length
	}
}

function installAdoptedStyleSheets(
	doc: ConstructableStylesheetsDocument,
): void {
	let sheets: Array<PolyfilledStyleSheet> = []
	let previous: Array<PolyfilledStyleSheet> = []

	const apply = (next: Array<PolyfilledStyleSheet>) => {
		syncAdoptedStyleSheets(doc, previous, next)
		previous = next.slice()
		sheets = next
		wirePush(sheets, () => {
			apply(sheets.slice())
		})
	}

	apply([])

	try {
		Object.defineProperty(doc, 'adoptedStyleSheets', {
			configurable: true,
			enumerable: true,
			get() {
				return sheets
			},
			set(value: ArrayLike<PolyfilledStyleSheet>) {
				apply(Array.from(value))
			},
		})
	} catch {
		try {
			doc.adoptedStyleSheets = sheets
		} catch {
			// Leave the document unchanged; Remix will still throw without adoption.
		}
	}
}

function installCssStyleSheetConstructor(
	host: ConstructableStylesheetsHost,
	doc: ConstructableStylesheetsDocument,
): void {
	function PolyfilledCSSStyleSheet(this: unknown): PolyfilledStyleSheet {
		// Returning an object from `new` replaces the constructed instance.
		return createPolyfilledStyleSheet(doc)
	}

	try {
		Object.defineProperty(host, 'CSSStyleSheet', {
			configurable: true,
			enumerable: false,
			writable: true,
			value: PolyfilledCSSStyleSheet,
		})
	} catch {
		try {
			;(host as { CSSStyleSheet: unknown }).CSSStyleSheet =
				PolyfilledCSSStyleSheet
		} catch {
			// Leave the host unchanged; Remix will still throw on construct.
		}
	}
}

export function ensureConstructableStylesheets(
	host: ConstructableStylesheetsHost | undefined = typeof globalThis ===
	'undefined'
		? undefined
		: (globalThis as ConstructableStylesheetsHost),
): void {
	if (!host?.document) return
	if (supportsConstructableStylesheets(host)) return

	installAdoptedStyleSheets(host.document)
	installCssStyleSheetConstructor(host, host.document)
}
