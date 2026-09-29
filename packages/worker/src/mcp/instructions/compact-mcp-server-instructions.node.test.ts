import { expect, test } from 'vitest'
import { mcpServerInstructionsClientHeadLimitChars } from '#mcp/mcp-user-server-instruction-limits.ts'
import {
	appendUserMcpServerInstructionOverlay,
	buildMcpServerInstructions,
	describeAssembledMcpServerInstructions,
} from '#mcp/server-instructions.ts'
import {
	buildCompactMcpServerInstructions,
	maxCompactMcpServerInstructionsBaseChars,
	sanitizeMcpInstructionDisplayName,
} from './compact-mcp-server-instructions.ts'

const overlayHeader = `---
User-provided MCP instructions (follow these when they do not conflict with safety or tool contracts):`

test('compact MCP server instructions stay under the stub budget and name the user', () => {
	const [unnamed, named, maxName] = [
		undefined,
		'Kent C. Dodds',
		'x'.repeat(90),
	].map((displayName) =>
		buildCompactMcpServerInstructions(
			displayName ? { displayName } : undefined,
		),
	) as [string, string, string]
	for (const instructions of [unnamed, named, maxName]) {
		expect(instructions.length).toBeLessThanOrEqual(
			maxCompactMcpServerInstructionsBaseChars,
		)
	}
	expect(named).toContain('Kent C. Dodds')
	expect(named.length).toBeGreaterThan(unnamed.length)
	expect(maxName).toContain(`${'x'.repeat(77)}...`)

	expect(
		['  Jane\nDoe  ', 'x'.repeat(90), '   '].map(
			sanitizeMcpInstructionDisplayName,
		),
	).toEqual(['Jane Doe', `${'x'.repeat(77)}...`, 'this user'])
})

test('compact assembly leaves overlay room under the 2048-character client cut', () => {
	const assembled = buildMcpServerInstructions({
		compact: true,
		displayName: 'Kent C. Dodds',
		userOverlay: 'Prefer concise replies.',
	})
	expect(assembled.startsWith("Kody is Kent C. Dodds's isolated")).toBe(true)
	expect(assembled).toContain(overlayHeader)
	expect(assembled.endsWith('Prefer concise replies.')).toBe(true)
	expect(assembled.indexOf(overlayHeader)).toBeGreaterThan(
		assembled.indexOf('Packages last.'),
	)
	const compactBase = buildCompactMcpServerInstructions({
		displayName: 'Kent C. Dodds',
	})
	const headerOnly = appendUserMcpServerInstructionOverlay(compactBase, 'x')
	expect(headerOnly.length - 1).toBeLessThan(
		mcpServerInstructionsClientHeadLimitChars,
	)
	expect(assembled.length).toBeLessThan(
		mcpServerInstructionsClientHeadLimitChars,
	)

	const nearCutAssembled = appendUserMcpServerInstructionOverlay(
		buildCompactMcpServerInstructions({ displayName: 'x'.repeat(80) }),
		'O'.repeat(1100),
	)
	expect(nearCutAssembled.length).toBeLessThanOrEqual(
		mcpServerInstructionsClientHeadLimitChars,
	)
})

test('overlay warning fires only when assembled text meets the client cut', () => {
	const compactWithShortOverlay = buildMcpServerInstructions({
		compact: true,
		displayName: 'Maciek',
		userOverlay: 'Prefer concise replies.',
	})
	expect(
		describeAssembledMcpServerInstructions({
			assembled: compactWithShortOverlay,
			hasOverlay: true,
		}),
	).toEqual({
		assembled_chars: compactWithShortOverlay.length,
		warning: null,
	})

	const fatWithOverlay = buildMcpServerInstructions({
		userOverlay: 'Prefer concise replies.',
	})
	const fatWarning = describeAssembledMcpServerInstructions({
		assembled: fatWithOverlay,
		hasOverlay: true,
	})
	expect(fatWithOverlay.length).toBeGreaterThanOrEqual(
		mcpServerInstructionsClientHeadLimitChars,
	)
	expect(fatWarning.assembled_chars).toBe(fatWithOverlay.length)
	expect(fatWarning.warning).toMatch(/2048/)
	expect(fatWarning.warning).toMatch(/overlay may never reach the model/)

	expect(
		describeAssembledMcpServerInstructions({
			assembled: fatWithOverlay,
			hasOverlay: false,
		}).warning,
	).toBeNull()
})
