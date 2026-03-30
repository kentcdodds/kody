import { type CapabilitySpec } from '#mcp/capabilities/types.ts'
import { type SkillParameterDefinition } from './skill-parameters.ts'

const defaultSkillEmbedMaxChars = 8_000
const maxDenormalizedCaps = 12

export function mergeInferredCapabilityNames(input: {
	astStaticNames: Array<string>
	usesCapabilities: Array<string> | undefined
	specs: Record<string, CapabilitySpec>
}): { merged: Array<string>; unknownNames: Array<string> } {
	const specKeys = new Set(Object.keys(input.specs))
	const out = new Set<string>()
	const unknown = new Set<string>()
	for (const name of input.astStaticNames) {
		if (specKeys.has(name)) out.add(name)
		else unknown.add(name)
	}
	for (const name of input.usesCapabilities ?? []) {
		if (specKeys.has(name)) out.add(name)
		else unknown.add(name)
	}
	return {
		merged: [...out].sort(),
		unknownNames: [...unknown].sort(),
	}
}

export function buildSkillEmbedText(
	input: {
		title: string
		description: string
		collectionName?: string | null
		collectionSlug?: string | null
		keywords: Array<string>
		searchText: string | null
		inferredCapabilities: Array<string>
		parameters?: Array<SkillParameterDefinition> | null
		specs: Record<string, CapabilitySpec>
	},
	maxChars: number = defaultSkillEmbedMaxChars,
): string {
	const baseParts = [
		input.title,
		input.description,
		...(input.collectionName
			? [
					`collection ${input.collectionName}`,
					...(input.collectionSlug ? [input.collectionSlug] : []),
				]
			: []),
		input.keywords.join(' '),
		...(input.searchText ? [input.searchText] : []),
		'meta',
		'skill',
	]
	const parameterParts =
		input.parameters && input.parameters.length > 0
			? input.parameters.map(
					(param) => `${param.name}: ${param.description} (${param.type})`,
				)
			: []
	const denorm: Array<string> = []
	let capCount = 0
	for (const name of input.inferredCapabilities) {
		if (capCount >= maxDenormalizedCaps) break
		const spec = input.specs[name]
		if (!spec) continue
		capCount += 1
		const fields = [...spec.inputFields, ...spec.outputFields].join(' ')
		denorm.push(
			[
				name,
				spec.domain,
				spec.description,
				spec.keywords.join(' '),
				fields,
			].join('\n'),
		)
	}
	const text = [...baseParts, ...parameterParts, ...denorm].join('\n')
	return text.slice(0, maxChars)
}

export type DerivedTrustFlags = {
	destructiveDerived: boolean
	/** When null, read-only cannot be inferred from the capability set. */
	readOnlyDerived: boolean | null
	idempotentDerived: boolean | null
}

export function deriveTrustFlags(
	inferredCapabilities: Array<string>,
	specs: Record<string, CapabilitySpec>,
	inferencePartial: boolean,
): DerivedTrustFlags {
	if (inferredCapabilities.length === 0) {
		return {
			destructiveDerived: false,
			readOnlyDerived: null,
			idempotentDerived: null,
		}
	}

	let destructiveDerived = false
	let readOnlyAnd = true
	let idempotentAnd = true
	for (const name of inferredCapabilities) {
		const spec = specs[name]
		if (!spec) continue
		if (spec.destructive) destructiveDerived = true
		if (!spec.readOnly) readOnlyAnd = false
		if (!spec.idempotent) idempotentAnd = false
	}

	const readOnlyDerived = inferencePartial ? null : readOnlyAnd

	let idempotentDerived: boolean | null = null
	if (!inferencePartial) {
		idempotentDerived = destructiveDerived ? false : idempotentAnd
	}

	return {
		destructiveDerived,
		readOnlyDerived,
		idempotentDerived,
	}
}

export function validateSkillSaveFlags(input: {
	agentReadOnly: boolean
	agentDestructive: boolean
	agentIdempotent: boolean
	derived: DerivedTrustFlags
	inferencePartial: boolean
	inferredCount: number
}): { ok: true } | { ok: false; message: string } {
	const trusted = !input.inferencePartial && input.inferredCount > 0

	if (input.agentReadOnly && input.derived.destructiveDerived) {
		return {
			ok: false,
			message:
				'read_only cannot be true when inferred capabilities include a destructive capability.',
		}
	}

	if (
		trusted &&
		input.derived.readOnlyDerived === false &&
		input.agentReadOnly
	) {
		return {
			ok: false,
			message:
				'read_only cannot be true: at least one inferred capability is not marked read-only.',
		}
	}

	if (trusted && input.derived.destructiveDerived && !input.agentDestructive) {
		return {
			ok: false,
			message:
				'destructive must be true when inferred capabilities include a destructive capability.',
		}
	}

	if (
		trusted &&
		input.derived.idempotentDerived === false &&
		input.agentIdempotent
	) {
		return {
			ok: false,
			message:
				'idempotent cannot be true given the inferred capabilities (heuristic): at least one is non-idempotent or the flow is destructive.',
		}
	}

	return { ok: true }
}
