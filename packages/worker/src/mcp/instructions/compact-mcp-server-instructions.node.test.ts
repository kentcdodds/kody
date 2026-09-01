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
	const unnamed = buildCompactMcpServerInstructions()
	expect(unnamed.length).toBeLessThanOrEqual(
		maxCompactMcpServerInstructionsBaseChars,
	)

	const named = buildCompactMcpServerInstructions({
		displayName: 'Kent C. Dodds',
	})
	expect(named.length).toBeLessThanOrEqual(
		maxCompactMcpServerInstructionsBaseChars,
	)
	expect(named).toContain('Kent C. Dodds')
	expect(named.length).toBeGreaterThan(unnamed.length)

	expect(sanitizeMcpInstructionDisplayName('  Jane\nDoe  ')).toBe('Jane Doe')
	expect(sanitizeMcpInstructionDisplayName('x'.repeat(90))).toBe(
		`${'x'.repeat(77)}...`,
	)
	expect(sanitizeMcpInstructionDisplayName('   ')).toBe('this user')
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
		assembled.indexOf('Lasting reusable behavior is a package.'),
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
