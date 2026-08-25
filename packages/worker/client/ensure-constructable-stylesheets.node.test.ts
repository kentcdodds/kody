import { expect, test } from 'vitest'
import { ensureConstructableStylesheets } from './ensure-constructable-stylesheets.ts'

type FakeRuleList = { length: number; rules: Array<string> }

function createFakeDocument() {
	const headChildren: Array<{ remove: () => void; isConnected: boolean }> = []
	const head = {
		appendChild(node: { isConnected: boolean }) {
			// Mirror DOM move semantics: re-appending a connected node relocates
			// it without disconnecting (CSSOM rules must survive).
			const existing = headChildren.indexOf(
				node as { remove: () => void; isConnected: boolean },
			)
			if (existing >= 0) headChildren.splice(existing, 1)
			node.isConnected = true
			headChildren.push(node as { remove: () => void; isConnected: boolean })
			return node
		},
	}

	const doc = {
		head,
		documentElement: head,
		createTextNode(data: string) {
			return { data }
		},
		createElement(tagName: string) {
			if (tagName !== 'style') {
				throw new Error(`unexpected element: ${tagName}`)
			}
			const rules: Array<string> = []
			const cssRules: FakeRuleList = {
				get length() {
					return rules.length
				},
				rules,
			}
			const sheet = {
				cssRules,
				insertRule(rule: string, index = 0) {
					rules.splice(index, 0, rule)
					return index
				},
				deleteRule(index: number) {
					rules.splice(index, 1)
				},
			}
			const style = {
				isConnected: false,
				appendChild(node: unknown) {
					return node
				},
				remove() {
					this.isConnected = false
					// Real browsers drop CSSOM mutations on disconnect and reparse
					// empty textContent on reconnect.
					rules.length = 0
					const index = headChildren.indexOf(this)
					if (index >= 0) headChildren.splice(index, 1)
				},
				get sheet() {
					// Expose `.sheet` only while connected — same as real browsers.
					return this.isConnected ? sheet : null
				},
			}
			return style
		},
	}

	return { doc, headChildren }
}

type PolyfilledSheet = {
	cssRules: { length: number }
	insertRule: (rule: string, index?: number) => number
	deleteRule: (index: number) => void
}

function installOnFakeHost() {
	const { doc, headChildren } = createFakeDocument()
	function NonConstructableCSSStyleSheet() {
		throw new TypeError('Illegal constructor')
	}
	const host = {
		CSSStyleSheet: NonConstructableCSSStyleSheet,
		document: doc,
	}
	ensureConstructableStylesheets(host)
	const Ctor = host.CSSStyleSheet as new () => PolyfilledSheet
	return { doc, headChildren, Ctor }
}

test('ensureConstructableStylesheets polyfills Illegal constructor hosts so Remix StyleManager construct + push + insertRule works', () => {
	const { doc, headChildren, Ctor } = installOnFakeHost()

	expect(typeof Ctor).toBe('function')
	expect(() => new Ctor()).not.toThrow()

	const sheet = new Ctor()

	doc.adoptedStyleSheets!.push(sheet as never)
	expect(headChildren).toHaveLength(1)
	expect(sheet.insertRule('.rmxc-x { color: red }', 0)).toBe(0)
	expect(sheet.cssRules.length).toBe(1)

	sheet.deleteRule(0)
	expect(sheet.cssRules.length).toBe(0)

	doc.adoptedStyleSheets = Array.from(doc.adoptedStyleSheets!).filter(
		(entry) => entry !== (sheet as never),
	)
	expect(headChildren).toHaveLength(0)
})

test('ensureConstructableStylesheets reorders connected style elements when adoptedStyleSheets is reassigned', () => {
	const { doc, headChildren, Ctor } = installOnFakeHost()

	const first = new Ctor()
	const second = new Ctor()
	doc.adoptedStyleSheets!.push(first as never, second as never)
	expect(headChildren).toHaveLength(2)
	const firstStyle = headChildren[0]
	const secondStyle = headChildren[1]

	doc.adoptedStyleSheets = [second as never, first as never]
	expect(headChildren).toEqual([secondStyle, firstStyle])
})

test('ensureConstructableStylesheets keeps insertRule CSSOM across reorder without disconnecting', () => {
	const { doc, headChildren, Ctor } = installOnFakeHost()

	const first = new Ctor()
	const second = new Ctor()
	doc.adoptedStyleSheets!.push(first as never, second as never)
	first.insertRule('.rmxc-a { color: red }', 0)
	second.insertRule('.rmxc-b { color: blue }', 0)

	doc.adoptedStyleSheets = [second as never, first as never]

	expect(headChildren).toHaveLength(2)
	expect(first.cssRules.length).toBe(1)
	expect(second.cssRules.length).toBe(1)
})

test('ensureConstructableStylesheets leaves a real Constructable Stylesheets implementation alone', () => {
	const existingSheet = { cssRules: { length: 0 } }
	function NativeCSSStyleSheet() {
		return existingSheet
	}
	const existingAdopted: Array<object> = []
	const doc = {
		createElement() {
			throw new Error('should not polyfill')
		},
		createTextNode() {
			throw new Error('should not polyfill')
		},
		adoptedStyleSheets: existingAdopted,
	}
	const host = {
		CSSStyleSheet: NativeCSSStyleSheet,
		document: doc,
	}

	ensureConstructableStylesheets(host)

	expect(host.CSSStyleSheet).toBe(NativeCSSStyleSheet)
	expect(doc.adoptedStyleSheets).toBe(existingAdopted)
	expect(new (host.CSSStyleSheet as new () => object)()).toBe(existingSheet)
})
