export type TranscriptInput = {
	name: string
	kind: 'query' | 'code' | 'memory'
	lang?: string
	value: string
}

export type TranscriptTool = {
	name: string
	summary: string
	note: string
	inputs: Array<TranscriptInput>
	resultLang?: string
	result: string
}

export type TranscriptFile = {
	path: string
	summary: string
	lang?: string
	content: string
}

export type TranscriptLine =
	| { role: 'user'; text: string }
	| { role: 'agent'; text: string; tone?: 'reasoning' }
	| { role: 'tools'; tools: Array<TranscriptTool> }
	| {
			role: 'files'
			summary: string
			note: string
			files: Array<TranscriptFile>
	  }

export type TranscriptAct = {
	id: string
	kicker: string
	title: string
	lines: Array<TranscriptLine>
}

export function jsonInput(value: unknown) {
	return JSON.stringify(value, null, 2)
}

export function memoryContextInput(context: {
	task: string
	entities: Array<string>
}) {
	return {
		name: 'memoryContext',
		kind: 'memory' as const,
		lang: 'json',
		value: jsonInput(context),
	}
}

export function conversationIdInput(conversationId: string) {
	return {
		name: 'conversationId',
		kind: 'query' as const,
		lang: 'json',
		value: jsonInput(conversationId),
	}
}

const conversationIdReturnNote =
	'Tool conversation id; pass it back on subsequent search/execute calls.'

export function conversationIdReturn(conversationId: string) {
	return `conversationId: ${conversationId}\n${conversationIdReturnNote}`
}

function relevantMemoriesMarkdown(
	memories: Array<{ subject: string; summary: string }>,
) {
	return [
		'## Relevant memories',
		'',
		...memories.map((memory) => `- **${memory.subject}** — ${memory.summary}`),
	].join('\n')
}

export function searchTextReturn(input: {
	conversationId: string
	body: string
	memories?: Array<{ subject: string; summary: string }>
}) {
	const parts = [conversationIdReturn(input.conversationId), '', input.body]
	if (input.memories && input.memories.length > 0) {
		parts.push('', relevantMemoriesMarkdown(input.memories))
	}
	return parts.join('\n')
}

export function executeTextReturn(input: {
	conversationId: string
	value: unknown
	memories?: Array<{ subject: string; summary: string }>
}) {
	const parts = [
		conversationIdReturn(input.conversationId),
		'',
		jsonInput(input.value),
	]
	if (input.memories && input.memories.length > 0) {
		parts.push('', relevantMemoriesMarkdown(input.memories))
	}
	return parts.join('\n')
}
