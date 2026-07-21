import { expect, test } from 'vitest'
import {
	buildBaseMcpServerInstructions,
	buildMcpServerInstructions,
	formatPopularPackagesInstructions,
	popularPackagesInstructionCharBudget,
} from './server-instructions.ts'

test('formatPopularPackagesInstructions omits cold-start empty lists', () => {
	expect(formatPopularPackagesInstructions(undefined)).toBe('')
	expect(formatPopularPackagesInstructions([])).toBe('')
})

test('formatPopularPackagesInstructions uses hint language and kody ids', () => {
	const section = formatPopularPackagesInstructions([
		{ kodyId: 'email-helper', description: 'Send and read mail' },
		{ kodyId: 'calendar-sync', description: '' },
	])
	expect(section).toContain('Often used from agents:')
	expect(section).toContain('discover others with `search`')
	expect(section).toContain('`email-helper`')
	expect(section).toContain('`calendar-sync`')
	expect(section).toContain('Send and read mail')
	expect(section.toLowerCase()).not.toContain('whitelist')
	expect(section.toLowerCase()).not.toContain('only these')
})

test('formatPopularPackagesInstructions caps entries and respects char budget', () => {
	const many = Array.from({ length: 12 }, (_, index) => ({
		kodyId: `pkg-${String(index + 1).padStart(2, '0')}`,
		description: 'A reasonably long one-line description for packing',
	}))
	const section = formatPopularPackagesInstructions(many)
	const listed = [...section.matchAll(/`pkg-\d+`/g)].map((match) => match[0])
	expect(listed.length).toBeLessThanOrEqual(8)
	expect(listed.length).toBeGreaterThan(0)
	expect(section.trim().length).toBeLessThanOrEqual(
		popularPackagesInstructionCharBudget + 10,
	)

	const tight = formatPopularPackagesInstructions(many, { charBudget: 80 })
	expect(tight).toContain('Often used from agents:')
	expect(tight).toContain('discover others with `search`')
	expect([...tight.matchAll(/`pkg-\d+`/g)].length).toBeLessThanOrEqual(2)
})

test('formatPopularPackagesInstructions truncates long descriptions', () => {
	const section = formatPopularPackagesInstructions([
		{
			kodyId: 'big-desc',
			description:
				'This description is intentionally very long so the formatter must truncate it for the instruction budget',
		},
	])
	expect(section).toContain('`big-desc`')
	expect(section).toContain('...')
	expect(section).not.toContain('instruction budget')
})

test('buildMcpServerInstructions includes popular packages and keeps overlay for prefs', () => {
	const instructions = buildMcpServerInstructions({
		popularPackages: [{ kodyId: 'notes', description: 'Scratch notes' }],
		userOverlay: 'Prefer concise replies.',
		domains: [],
	})
	expect(instructions).toContain('Often used from agents:')
	expect(instructions).toContain('`notes`')
	expect(instructions).toContain('not for maintaining a package inventory')
	expect(instructions).toContain('User-provided MCP instructions')
	expect(instructions).toContain('Prefer concise replies.')
})

test('buildBaseMcpServerInstructions omits popular section when empty', () => {
	const base = buildBaseMcpServerInstructions({ popularPackages: [] })
	expect(base).not.toContain('Often used from agents:')
})
