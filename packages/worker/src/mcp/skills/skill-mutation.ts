import { inferCodemodeCapabilities } from './infer-codemode-capabilities.ts'
import {
	buildSkillEmbedText,
	deriveTrustFlags,
	type DerivedTrustFlags,
	mergeInferredCapabilityNames,
	validateSkillSaveFlags,
} from './skill-embed-and-flags.ts'
import { parseSkillCollection } from './skill-collections.ts'
import { type McpSkillRow } from './mcp-skills-types.ts'
import { normalizeSkillName } from './skill-names.ts'
import {
	normalizeSkillParameters,
	parseSkillParameters,
	type SkillParameterInput,
} from './skill-parameters.ts'

function parseJsonStringArray(raw: string): Array<string> {
	try {
		const v = JSON.parse(raw) as unknown
		if (!Array.isArray(v)) return []
		return v.filter((x): x is string => typeof x === 'string')
	} catch {
		return []
	}
}

export async function buildSkillEmbedTextFromStoredRow(
	row: McpSkillRow,
): Promise<string> {
	const { capabilitySpecs } = await import('#mcp/capabilities/registry.ts')
	const keywords = parseJsonStringArray(row.keywords)
	const parameters = parseSkillParameters(row.parameters)
	let inferred: Array<string> = []
	try {
		const v = JSON.parse(row.inferred_capabilities) as unknown
		if (Array.isArray(v)) {
			inferred = v.filter((x): x is string => typeof x === 'string')
		}
	} catch {
		inferred = []
	}
	return buildSkillEmbedText({
		title: row.title,
		description: row.description,
		collectionName: row.collection_name,
		collectionSlug: row.collection_slug,
		keywords,
		searchText: row.search_text,
		inferredCapabilities: inferred,
		parameters,
		specs: capabilitySpecs,
	})
}

export type SkillPersistenceArgs = {
	name: string
	title: string
	description: string
	collection?: string | undefined
	keywords: Array<string>
	code: string
	search_text?: string | undefined
	uses_capabilities?: Array<string> | undefined
	parameters?: Array<SkillParameterInput> | undefined
	read_only: boolean
	idempotent: boolean
	destructive: boolean
}

export type PreparedSkillPersistence = {
	merged: Array<string>
	inferencePartial: boolean
	derived: DerivedTrustFlags
	warnings: Array<string>
	embedText: string
	rowPayload: {
		name: string
		title: string
		description: string
		collection_name: string | null
		collection_slug: string | null
		keywords: string
		code: string
		search_text: string | null
		uses_capabilities: string | null
		parameters: string | null
		inferred_capabilities: string
		inference_partial: 0 | 1
		read_only: 0 | 1
		idempotent: 0 | 1
		destructive: 0 | 1
	}
}

export async function prepareSkillPersistence(
	args: SkillPersistenceArgs,
): Promise<PreparedSkillPersistence> {
	const [{ normalizeCode }, { capabilitySpecs }] = await Promise.all([
		import('@cloudflare/codemode'),
		import('#mcp/capabilities/registry.ts'),
	] as const)

	const normalized = normalizeCode(args.code)
	const infer = inferCodemodeCapabilities(normalized)
	const { merged, unknownNames } = mergeInferredCapabilityNames({
		astStaticNames: [...infer.staticNames, ...infer.helperNames],
		usesCapabilities: args.uses_capabilities,
		specs: capabilitySpecs,
	})
	if (unknownNames.length > 0) {
		throw new Error(`Unknown capability name(s): ${unknownNames.join(', ')}.`)
	}
	const inferencePartial = infer.inferencePartial || merged.length === 0
	const derived = deriveTrustFlags(merged, capabilitySpecs, inferencePartial)
	const validation = validateSkillSaveFlags({
		agentReadOnly: args.read_only,
		agentDestructive: args.destructive,
		agentIdempotent: args.idempotent,
		derived,
		inferencePartial,
		inferredCount: merged.length,
	})
	if (!validation.ok) {
		throw new Error(validation.message)
	}
	const warnings: Array<string> = []
	if (inferencePartial) {
		warnings.push(
			'Capability inference is partial (dynamic codemode access, parse edge cases, or no static names). Trust flags were not fully validated against the full code path.',
		)
	}

	const parameters = normalizeSkillParameters(args.parameters)
	const collection = parseSkillCollection(args.collection)
	const skillName = normalizeSkillName(args.name)
	const embedText = buildSkillEmbedText({
		title: args.title,
		description: args.description,
		collectionName: collection?.name ?? null,
		collectionSlug: collection?.slug ?? null,
		keywords: args.keywords,
		searchText: args.search_text ?? null,
		inferredCapabilities: merged,
		parameters,
		specs: capabilitySpecs,
	})

	const rowPayload = {
		name: skillName,
		title: args.title,
		description: args.description,
		collection_name: collection?.name ?? null,
		collection_slug: collection?.slug ?? null,
		keywords: JSON.stringify(args.keywords),
		code: args.code,
		search_text: args.search_text ?? null,
		uses_capabilities: args.uses_capabilities
			? JSON.stringify(args.uses_capabilities)
			: null,
		parameters: parameters ? JSON.stringify(parameters) : null,
		inferred_capabilities: JSON.stringify(merged),
		inference_partial: (inferencePartial ? 1 : 0) as 0 | 1,
		read_only: (args.read_only ? 1 : 0) as 0 | 1,
		idempotent: (args.idempotent ? 1 : 0) as 0 | 1,
		destructive: (args.destructive ? 1 : 0) as 0 | 1,
	}

	return {
		merged,
		inferencePartial,
		derived,
		warnings,
		embedText,
		rowPayload,
	}
}
