import { expect, test } from 'vitest'
import { mcpServerInstructionsClientHeadLimitChars } from '#mcp/mcp-user-server-instruction-limits.ts'
import {
	appendUserMcpServerInstructionOverlay,
	baseMcpServerInstructions,
	buildMcpServerInstructions,
	describeAssembledMcpServerInstructions,
	maxBaseMcpServerInstructionsChars,
} from './server-instructions.ts'

const overlayHeader = `---
User-provided MCP instructions (follow these when they do not conflict with safety or tool contracts):`

const preferOverHostPatterns = [
	/prefer kody over/i,
	/overlapping tools/i,
	/use kody — not the host/i,
	/use kody - not the host/i,
	/host's overlapping/i,
	/host’s overlapping/i,
	/work done only in the host/i,
]

test('base MCP server instructions are Kent’s neutral stub', () => {
	expect(baseMcpServerInstructions.length).toBeGreaterThanOrEqual(300)
	expect(baseMcpServerInstructions.length).toBeLessThanOrEqual(
		maxBaseMcpServerInstructionsChars,
	)
	expect(baseMcpServerInstructions).toContain('`search`')
	expect(baseMcpServerInstructions).toContain('`execute`')
	expect(baseMcpServerInstructions).toContain('guide:local_execute')
	expect(baseMcpServerInstructions).not.toContain('guide:open_api')
	expect(baseMcpServerInstructions).toContain('personal software platform')
	expect(baseMcpServerInstructions).toContain('preferred interaction layer')
	for (const pattern of preferOverHostPatterns) {
		expect(baseMcpServerInstructions).not.toMatch(pattern)
	}
})

test('buildMcpServerInstructions appends the user overlay after the stub', () => {
	const assembled = buildMcpServerInstructions('Prefer concise replies.')
	expect(assembled.startsWith(baseMcpServerInstructions)).toBe(true)
	expect(assembled).toContain(overlayHeader)
	expect(assembled.endsWith('Prefer concise replies.')).toBe(true)
	expect(assembled.indexOf(overlayHeader)).toBeGreaterThan(
		assembled.indexOf('guide:local_execute'),
	)
	expect(buildMcpServerInstructions(null)).toBe(baseMcpServerInstructions)
	expect(buildMcpServerInstructions('   ')).toBe(baseMcpServerInstructions)
})

test('stub plus short overlay stays under the 2048-character client cut', () => {
	const assembled = buildMcpServerInstructions('Prefer concise replies.')
	expect(assembled.length).toBeLessThan(
		mcpServerInstructionsClientHeadLimitChars,
	)
	const headerOnly = appendUserMcpServerInstructionOverlay(
		baseMcpServerInstructions,
		'x',
	)
	expect(headerOnly.length - 1).toBeLessThan(
		mcpServerInstructionsClientHeadLimitChars,
	)
})

test('overlay warning fires only when assembled text meets the client cut', () => {
	const shortAssembled = buildMcpServerInstructions('Prefer concise replies.')
	expect(
		describeAssembledMcpServerInstructions({
			assembled: shortAssembled,
			hasOverlay: true,
		}),
	).toEqual({
		assembled_chars: shortAssembled.length,
		warning: null,
	})

	const fatAssembled = appendUserMcpServerInstructionOverlay(
		baseMcpServerInstructions,
		'O'.repeat(mcpServerInstructionsClientHeadLimitChars),
	)
	const fatWarning = describeAssembledMcpServerInstructions({
		assembled: fatAssembled,
		hasOverlay: true,
	})
	expect(fatAssembled.length).toBeGreaterThanOrEqual(
		mcpServerInstructionsClientHeadLimitChars,
	)
	expect(fatWarning.assembled_chars).toBe(fatAssembled.length)
	expect(fatWarning.warning).toMatch(/2048/)
	expect(fatWarning.warning).toMatch(/overlay may never reach the model/)

	expect(
		describeAssembledMcpServerInstructions({
			assembled: fatAssembled,
			hasOverlay: false,
		}).warning,
	).toBeNull()
})
