export type MockAiResponse =
	| {
			kind: 'text'
			text: string
			chunks?: Array<string>
	  }
	| {
			kind: 'tool-call'
			toolName: string
			input: Record<string, unknown>
			text?: string
	  }
	| {
			kind: 'error'
			message: string
	  }

export function buildHelpResponse(toolNames: Array<string>): MockAiResponse {
	const sortedToolNames = [...toolNames].sort((left, right) =>
		left.localeCompare(right),
	)
	const lines = [
		'This is the mock AI worker.',
		'',
		'Supported messages:',
		'- help',
		'- stream',
		'- error',
		'- tool:do_math;left=1;right=2;operator=+',
	]

	if (sortedToolNames.length > 0) {
		lines.push('', `Available tools: ${sortedToolNames.join(', ')}`)
	}

	return {
		kind: 'text',
		text: lines.join('\n'),
	}
}

function parseScalar(value: string) {
	const trimmed = value.trim()
	if (trimmed === 'true') return true
	if (trimmed === 'false') return false
	if (trimmed === 'null') return null
	if (trimmed === 'undefined') return undefined
	if (trimmed === '') return ''

	const numericValue = Number(trimmed)
	if (!Number.isNaN(numericValue) && trimmed === String(numericValue)) {
		return numericValue
	}

	return trimmed
}

export function parseMockToolCommand(input: string) {
	const [toolSegment, ...pairs] = input.split(';')
	if (!toolSegment) return null
	if (!toolSegment.startsWith('tool:')) return null

	const toolName = toolSegment.slice('tool:'.length).trim()
	if (!toolName) return null

	const parsedInput: Record<string, unknown> = {}
	for (const pair of pairs) {
		const [rawKey, ...rawValueParts] = pair.split('=')
		const key = rawKey?.trim()
		if (!key) continue
		parsedInput[key] = parseScalar(rawValueParts.join('='))
	}

	return {
		toolName,
		input: parsedInput,
	}
}

export function buildMockAiScenario(input: {
	lastUserMessage: string
	toolNames: Array<string>
}): {
	scenario: string
	response: MockAiResponse
} {
	const normalized = input.lastUserMessage.trim()
	if (!normalized) {
		return {
			scenario: 'default',
			response: {
				kind: 'text',
				text: 'This is a mock completion, send "help" for messages you can send to trigger tool calls.',
			},
		}
	}

	if (normalized === 'help') {
		return {
			scenario: 'help',
			response: buildHelpResponse(input.toolNames),
		}
	}

	if (normalized === 'stream') {
		return {
			scenario: 'stream',
			response: {
				kind: 'text',
				text: 'This is a streamed mock completion.',
				chunks: ['This is ', 'a streamed ', 'mock completion.'],
			},
		}
	}

	if (normalized === 'error') {
		return {
			scenario: 'error',
			response: {
				kind: 'error',
				message: 'Mock AI forced an error for testing.',
			},
		}
	}

	const toolCommand = parseMockToolCommand(normalized)
	if (toolCommand) {
		return {
			scenario: `tool:${toolCommand.toolName}`,
			response: {
				kind: 'tool-call',
				toolName: toolCommand.toolName,
				input: toolCommand.input,
				text: `Executed mock tool trigger for ${toolCommand.toolName}.`,
			},
		}
	}

	return {
		scenario: 'default',
		response: {
			kind: 'text',
			text: 'This is a mock completion, send "help" for messages you can send to trigger tool calls.',
		},
	}
}
