/**
 * Inline package-export call contracts on high-confidence top ranked hits.
 *
 * Mirrors capability `attachTopCapabilityCallShapes`: agents get import path
 * + signature/types (same substance as `entity: package:{id}#{subpath}`)
 * without a second round-trip when the top hit is clearly the right export.
 * Ambiguous top-2 / weak scores stay skinny and point at entity detail.
 */

import { buildPackageImportSpecifier } from '#worker/package-registry/package-import-specifier.ts'

import {
	exportCallContractMinJevMeanConfidence,
	exportCallContractMinScoreGap,
	exportCallContractMinTopScore,
	inlineExportCallContractTypeMaxLength,
} from './search-constants.ts'
import {
	buildPackageActionImportUsage,
	compactCapabilityInputTypeDefinition,
	getPrimaryPackageActionFunction,
} from './search-format-helpers.ts'
import {
	type JevSearchRerankOutcome,
	type SearchMatch,
} from './search-format-types.ts'
import { type SearchCandidate } from './search-types.ts'

function isDefaultExportName(name: string) {
	return name === 'default' || name === 'home'
}

function buildExportExecuteExample(input: {
	packageName: string
	subpath: string
	functions: ReadonlyArray<{ name: string }>
}): string {
	const importSpecifier = buildPackageImportSpecifier(
		input.packageName,
		input.subpath,
	)
	const primary = getPrimaryPackageActionFunction({
		functions: input.functions,
	})
	if (!primary) {
		return `import * as exported from ${JSON.stringify(importSpecifier)}

export default async function main() {
	return exported
}`
	}
	const isDefaultImport = isDefaultExportName(primary.name)
	const localName = isDefaultImport ? 'action' : primary.name
	const importLine = isDefaultImport
		? `import ${localName} from ${JSON.stringify(importSpecifier)}`
		: `import { ${localName} } from ${JSON.stringify(importSpecifier)}`
	return `${importLine}

export default async function main(params) {
	return await ${localName}(params)
}`
}

/**
 * Whether the top ranked hit should carry an inlined export call contract.
 *
 * Uses post-Jev meanConfidence when Jev applied; otherwise hybrid score gap
 * and top-1 floor. Ambiguous top-2 (gap below threshold) never inlines.
 */
export function shouldInlineExportCallContract(input: {
	matches: ReadonlyArray<SearchMatch>
	hybridCandidates: ReadonlyArray<SearchCandidate>
	jevOutcome: JevSearchRerankOutcome
	jevMeanConfidence: number | null
}): boolean {
	const [topMatch, secondMatch] = input.matches
	if (topMatch?.type !== 'package' || !topMatch.exportSubpath) return false
	const [actionMatch] = topMatch.actionMatches ?? []
	if (!actionMatch) return false

	if (input.jevOutcome === 'applied') {
		const mean = input.jevMeanConfidence
		if (mean == null || mean < exportCallContractMinJevMeanConfidence) {
			return false
		}
		// Same-package rival export in slot 2 → keep skinny; entity for detail.
		if (
			secondMatch?.type === 'package' &&
			secondMatch.exportSubpath &&
			secondMatch.kodyId === topMatch.kodyId
		) {
			return false
		}
		return true
	}

	const topCandidate = input.hybridCandidates[0]
	const secondCandidate = input.hybridCandidates[1]
	if (!topCandidate) return false
	const topScore = topCandidate.scoreComponents.final
	if (topScore < exportCallContractMinTopScore) return false
	if (!secondCandidate) return true
	const gap = topScore - secondCandidate.scoreComponents.final
	return gap >= exportCallContractMinScoreGap
}

/**
 * Attach a compact export call contract to the top match when confidence
 * is high. Mutates `matches[0]` in place (same pattern as capability shapes).
 */
export function attachHighConfidenceExportCallContract(input: {
	matches: Array<SearchMatch>
	hybridCandidates: ReadonlyArray<SearchCandidate>
	jevOutcome: JevSearchRerankOutcome
	jevMeanConfidence: number | null
}): void {
	if (!shouldInlineExportCallContract(input)) return
	const topMatch = input.matches[0]
	if (topMatch?.type !== 'package' || !topMatch.exportSubpath) return
	const [actionMatch] = topMatch.actionMatches ?? []
	if (!actionMatch) return

	const importSpecifier = buildPackageImportSpecifier(
		topMatch.name,
		actionMatch.subpath,
	)
	const primary = getPrimaryPackageActionFunction(actionMatch)
	const usage = primary
		? buildPackageActionImportUsage({
				packageName: topMatch.name,
				subpath: actionMatch.subpath,
				functionName: primary.name,
			})
		: `import * as exported from ${JSON.stringify(importSpecifier)}`
	const rawType =
		actionMatch.typeDefinition ??
		primary?.typeDefinition ??
		actionMatch.functions.map((fn) => fn.typeDefinition).find(Boolean) ??
		null
	let typeDefinition: string | null = null
	let typeDefinitionTruncated = false
	if (rawType) {
		const compact = compactCapabilityInputTypeDefinition(rawType, {
			maxLength: inlineExportCallContractTypeMaxLength,
		})
		typeDefinition = compact.definition
		typeDefinitionTruncated = compact.truncated
	}
	topMatch.exportCallContract = {
		importSpecifier,
		usage,
		executeExample: buildExportExecuteExample({
			packageName: topMatch.name,
			subpath: actionMatch.subpath,
			functions: actionMatch.functions,
		}),
		typeDefinition,
		...(typeDefinitionTruncated ? { typeDefinitionTruncated: true } : {}),
		functions: actionMatch.functions.map((fn) => ({
			name: fn.name,
			description: fn.description,
			typeDefinition: fn.typeDefinition
				? compactCapabilityInputTypeDefinition(fn.typeDefinition, {
						maxLength: inlineExportCallContractTypeMaxLength,
					}).definition
				: null,
		})),
	}
}
