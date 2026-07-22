import {
	escapeMarkdownText,
	formatMarkdownInlineCode,
} from './markdown-safety.ts'
import {
	buildEntityRef,
	buildKodyCapabilityAccessor,
	buildPackageActionImportUsage,
	formatOneLineSentence,
	getPrimaryPackageActionFunction,
} from './search-format-helpers.ts'
import { type SearchMatch } from './search-format-types.ts'

export function formatSearchMarkdown(input: {
	matches: Array<SearchMatch>
	warnings?: Array<string>
	warningCount?: number
	includePreamble?: boolean
}) {
	const lines: Array<string> = ['# Search results', '']
	const hasEntityBackedMatch = input.matches.some(
		(match) => match.type !== 'retriever_result',
	)
	if ((input.includePreamble ?? true) && hasEntityBackedMatch) {
		lines.push(
			'For full detail on entity-backed hits, call `search` with `entity: "{id}:{type}"`.',
			'',
		)
	}

	if (input.matches.length === 0) {
		lines.push(
			'> **No matches.** Rephrase `query` or call `meta_list_capabilities` for the full capability registry. `entity` looks up a known id — it does not improve an empty ranked list.',
		)
	} else {
		input.matches.forEach((match, index) => {
			lines.push(formatMatchListItem(match, index))
		})
	}

	const warningCount = input.warningCount ?? input.warnings?.length ?? 0
	if (warningCount > 0) {
		lines.push(
			'',
			`> ${String(warningCount)} search notice(s) available in the structured result.`,
		)
	}

	return lines.join('\n').trim()
}

function formatMatchListItem(match: SearchMatch, index: number) {
	if (match.type === 'capability') {
		const entityRef = buildEntityRef(match.name, 'capability')
		const mainLine = `${String(index + 1)}. **capability** ${formatMarkdownInlineCode(match.name)} — ${escapeMarkdownText(formatOneLineSentence(match.description))} Entity: ${formatMarkdownInlineCode(entityRef)}`
		if (!match.inputTypeDefinition) {
			return mainLine
		}
		const accessor = buildKodyCapabilityAccessor(match)
		const truncatedNote = match.inputTypeDefinitionTruncated
			? '; use entity detail for the full definition'
			: ''
		return `${mainLine}\n   ${formatMarkdownInlineCode(`${accessor}(args)`)} — ${formatMarkdownInlineCode(match.inputTypeDefinition)}${truncatedNote}`
	}
	if (match.type === 'package') {
		const entityRef = buildEntityRef(match.kodyId, 'package')
		const [actionMatch] = match.actionMatches ?? []
		const actionFunction = actionMatch
			? getPrimaryPackageActionFunction(actionMatch)
			: null
		const actionSummary =
			actionMatch && actionFunction
				? ` Best action: ${formatMarkdownInlineCode(actionFunction.name)} via ${formatMarkdownInlineCode(buildPackageActionImportUsage({ packageName: match.name, subpath: actionMatch.subpath, functionName: actionFunction.name }))}${actionFunction.description ? ` — ${escapeMarkdownText(formatOneLineSentence(actionFunction.description))}` : ''}`
				: ''
		return `${String(index + 1)}. **package** ${escapeMarkdownText(match.title)} (${formatMarkdownInlineCode(match.kodyId)}) — ${escapeMarkdownText(formatOneLineSentence(match.description))} Entity: ${formatMarkdownInlineCode(entityRef)}${actionSummary}`
	}
	if (match.type === 'value') {
		const entityRef = buildEntityRef(match.valueId, 'value')
		return `${String(index + 1)}. **value** ${formatMarkdownInlineCode(match.name)} (${formatMarkdownInlineCode(match.scope)} scope) — ${escapeMarkdownText(formatOneLineSentence(match.description))} Entity: ${formatMarkdownInlineCode(entityRef)}`
	}
	if (match.type === 'integration') {
		const entityRef = buildEntityRef(match.integrationName, 'integration')
		return `${String(index + 1)}. **integration** ${formatMarkdownInlineCode(match.integrationName)} — ${escapeMarkdownText(formatOneLineSentence(match.description))} Entity: ${formatMarkdownInlineCode(entityRef)}`
	}
	if (match.type === 'retriever_result') {
		const source = match.source ?? `${match.kodyId}/${match.retrieverKey}`
		return `${String(index + 1)}. **retriever result** ${escapeMarkdownText(match.title)} — ${escapeMarkdownText(formatOneLineSentence(match.summary))} Source: ${formatMarkdownInlineCode(source)}`
	}
	const entityRef = buildEntityRef(match.name, 'secret')
	return `${String(index + 1)}. **secret** ${formatMarkdownInlineCode(match.name)} — ${escapeMarkdownText(formatOneLineSentence(match.description))} Entity: ${formatMarkdownInlineCode(entityRef)}`
}
