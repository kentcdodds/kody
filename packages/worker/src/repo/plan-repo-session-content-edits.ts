export type RepoSessionContentEditInstruction =
	| {
			kind: 'write'
			path: string
			content: string
	  }
	| {
			kind: 'replace'
			path: string
			search: string
			replacement: string
			options?: {
				caseSensitive?: boolean
				regex?: boolean
				wholeWord?: boolean
			}
	  }
	| {
			kind: 'writeJson'
			path: string
			value: unknown
			options?: {
				spaces?: number
			}
	  }

export type RepoSessionPlannedContentEdit = {
	instruction: RepoSessionContentEditInstruction
	path: string
	changed: boolean
	content: string
	diff: string
}

export type RepoSessionContentEditPlan = {
	edits: Array<RepoSessionPlannedContentEdit>
	totalChanged: number
	totalInstructions: number
}

/**
 * Plan write/replace/writeJson instructions against a staged overlay so
 * same-path edits compose in order.
 *
 * `@cloudflare/shell` `planEdits` reads each instruction against the file
 * state at batch start, so a batch of replaces on one path all derive from
 * the original contents and `applyEditPlan` keeps only the last write.
 */
export async function planRepoSessionContentEdits(
	instructions: ReadonlyArray<RepoSessionContentEditInstruction>,
	readFileIfExists: (path: string) => Promise<string | null>,
): Promise<RepoSessionContentEditPlan> {
	const overlay = new Map<string, string | null>()
	const edits: Array<RepoSessionPlannedContentEdit> = []
	let totalChanged = 0
	for (const instruction of instructions) {
		const previous = overlay.has(instruction.path)
			? (overlay.get(instruction.path) ?? null)
			: await readFileIfExists(instruction.path)
		const content = plannedContentForInstruction(instruction, previous)
		const changed = previous !== content
		overlay.set(instruction.path, content)
		edits.push({
			instruction,
			path: instruction.path,
			changed,
			content,
			diff: '',
		})
		if (changed) totalChanged += 1
	}
	return {
		edits,
		totalChanged,
		totalInstructions: instructions.length,
	}
}

function plannedContentForInstruction(
	instruction: RepoSessionContentEditInstruction,
	previous: string | null,
) {
	switch (instruction.kind) {
		case 'write':
			return instruction.content
		case 'writeJson':
			return stringifyJsonFileContent(
				instruction.value,
				instruction.path,
				instruction.options?.spaces,
			)
		case 'replace':
			if (previous === null) {
				throw new Error(`ENOENT: no such file: ${instruction.path}`)
			}
			return replaceTextContent(
				previous,
				instruction.search,
				instruction.replacement,
				instruction.options,
			)
		default: {
			const exhaustive: never = instruction
			return exhaustive
		}
	}
}

function stringifyJsonFileContent(value: unknown, path: string, spaces = 2) {
	const serialized = JSON.stringify(value, null, spaces)
	if (serialized === undefined) {
		throw new Error(`Unable to serialize JSON for ${path}`)
	}
	return `${serialized}\n`
}

function replaceTextContent(
	content: string,
	search: string,
	replacement: string,
	options?: {
		caseSensitive?: boolean
		regex?: boolean
		wholeWord?: boolean
	},
) {
	const matcher = createTextMatcher(search, options ?? {})
	// Replacer function keeps `$`, `$&`, and `$$` literal, matching
	// `@cloudflare/shell` replaceTextContent.
	return content.replace(matcher, () => replacement)
}

function createTextMatcher(
	query: string,
	options: {
		caseSensitive?: boolean
		regex?: boolean
		wholeWord?: boolean
	},
) {
	if (query.length === 0) {
		throw new Error('Search query must not be empty')
	}
	let source = options.regex ? query : escapeRegExp(query)
	if (options.wholeWord) {
		source = `\\b(?:${source})\\b`
	}
	try {
		return new RegExp(source, options.caseSensitive === false ? 'gi' : 'g')
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(`Invalid search pattern: ${message}`)
	}
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
