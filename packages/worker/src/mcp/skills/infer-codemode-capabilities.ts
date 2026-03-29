import { parse, type Node, type Program } from 'acorn'
import {
	codemodeSandboxModuleManifest,
} from '#mcp/generated/codemode-sandbox-modules.ts'

export type InferCodemodeCapabilitiesResult = {
	/** Resolved capability names from static member access on `codemode`. */
	staticNames: Array<string>
	/** Resolved capability names from known execute-time helper module imports. */
	moduleNames: Array<string>
	/**
	 * True when `codemode[dynamic]` or parsing failed (caller may still merge explicit uses).
	 */
	inferencePartial: boolean
}

function isCodemodeIdentifier(node: unknown): boolean {
	return (
		typeof node === 'object' &&
		node !== null &&
		'type' in node &&
		(node as { type: string }).type === 'Identifier' &&
		'name' in node &&
		(node as { name: string }).name === 'codemode'
	)
}

function peekMemberPropertyName(
	property: unknown,
	computed: boolean,
	onPartial: () => void,
): string | null {
	if (!computed) {
		if (
			typeof property === 'object' &&
			property !== null &&
			'type' in property &&
			(property as { type: string }).type === 'Identifier' &&
			'name' in property
		) {
			return (property as { name: string }).name
		}
		return null
	}
	if (
		typeof property === 'object' &&
		property !== null &&
		'type' in property &&
		(property as { type: string }).type === 'Literal'
	) {
		const v = (property as unknown as { value: unknown }).value
		if (typeof v === 'string' && v.length > 0) return v
	}
	onPartial()
	return null
}

function readStaticString(node: unknown) {
	if (
		typeof node === 'object' &&
		node !== null &&
		'type' in node &&
		(node as { type: string }).type === 'Literal'
	) {
		const value = (node as { value?: unknown }).value
		return typeof value === 'string' && value.length > 0 ? value : null
	}
	return null
}

/** Walk ESTree-ish nodes produced by acorn; collect codemode.<name> accesses. */
export function inferCodemodeCapabilitiesFromAst(
	program: Program,
): InferCodemodeCapabilitiesResult {
	const staticSet = new Set<string>()
	const moduleSet = new Set<string>()
	let inferencePartial = false
	const markPartial = () => {
		inferencePartial = true
	}

	function visit(node: unknown): void {
		if (node === null || typeof node !== 'object') return

		if (Array.isArray(node)) {
			for (const item of node) visit(item)
			return
		}

		if (!('type' in node)) return
		const n = node as Node

		if (n.type === 'MemberExpression') {
			const obj = 'object' in n ? (n as { object: unknown }).object : null
			if (isCodemodeIdentifier(obj)) {
				const prop =
					'property' in n ? (n as { property: unknown }).property : null
				const computed = Boolean(
					'computed' in n && (n as { computed?: boolean }).computed,
				)
				const name = peekMemberPropertyName(prop, computed, markPartial)
				if (name) staticSet.add(name)
			}
		}

		if (n.type === 'ImportExpression') {
			const source = readStaticString(
				(n as { source?: unknown }).source ?? null,
			)
			if (source) {
				for (const capabilityName of codemodeSandboxModuleManifest[source] ?? []) {
					moduleSet.add(capabilityName)
				}
			}
		}

		if (n.type === 'ChainExpression') {
			const expr = (n as unknown as { expression: unknown }).expression
			visit(expr)
		}

		for (const key of Object.keys(n)) {
			if (key === 'type') continue
			const v = (n as unknown as Record<string, unknown>)[key]
			if (v === null || v === undefined) continue
			if (typeof v === 'object' && !Array.isArray(v) && 'type' in v) {
				visit(v)
			} else if (Array.isArray(v)) {
				for (const item of v) visit(item)
			}
		}
	}

	visit(program)

	return {
		staticNames: [...staticSet].sort(),
		moduleNames: [...moduleSet].sort(),
		inferencePartial,
	}
}

/**
 * Parse normalized codemode source (same options as `@cloudflare/codemode` `normalizeCode`).
 * On parse failure, returns empty static set and `inferencePartial: true`.
 */
export function inferCodemodeCapabilities(
	normalizedSource: string,
): InferCodemodeCapabilitiesResult {
	try {
		const program = parse(normalizedSource, {
			ecmaVersion: 'latest',
			sourceType: 'module',
		})
		return inferCodemodeCapabilitiesFromAst(program)
	} catch {
		return { staticNames: [], moduleNames: [], inferencePartial: true }
	}
}
