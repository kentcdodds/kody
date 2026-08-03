import { expect, test } from 'vitest'
import {
	buildBaseMcpServerInstructions,
	buildMcpServerInstructions,
	formatPopularPackagesInstructions,
	popularPackagesInstructionCharBudget,
} from './server-instructions.ts'

test('popular package MCP instructions omit cold start, list kody ids under budget, and keep overlays', () => {
	expect(formatPopularPackagesInstructions(undefined)).toBe('')
	expect(formatPopularPackagesInstructions([])).toBe('')
	expect(buildBaseMcpServerInstructions({ popularPackages: [] })).not.toMatch(
		/`email-helper`|`notes`/,
	)

	const section = formatPopularPackagesInstructions([
		{ kodyId: 'email-helper', description: 'Send and read mail' },
		{ kodyId: 'calendar-sync', description: '' },
	])
	expect(section).toMatch(/`email-helper`/)
	expect(section).toMatch(/`calendar-sync`/)
	expect(section).toContain('- `email-helper`')
	expect(section).not.toContain('Send and read mail')

	const many = Array.from({ length: 12 }, (_, index) => ({
		kodyId: `pkg-${String(index + 1).padStart(2, '0')}`,
		description: 'A reasonably long one-line description for packing',
	}))
	const capped = formatPopularPackagesInstructions(many)
	const listed = [...capped.matchAll(/`pkg-\d+`/g)].map((match) => match[0])
	expect(listed.length).toBeGreaterThan(0)
	expect(listed.length).toBeLessThanOrEqual(8)
	expect(capped.trim().length).toBeLessThanOrEqual(
		popularPackagesInstructionCharBudget + 10,
	)
	expect(
		[
			...formatPopularPackagesInstructions(many, { charBudget: 80 }).matchAll(
				/`pkg-\d+`/g,
			),
		].length,
	).toBeLessThanOrEqual(2)

	const instructions = buildMcpServerInstructions({
		popularPackages: [{ kodyId: 'notes', description: 'Scratch notes' }],
		userOverlay: 'Prefer concise replies.',
		domains: [],
	})
	expect(instructions).toMatch(/`notes`/)
	expect(instructions).toContain('Prefer concise replies.')
	expect(instructions).not.toContain('Connected remote connectors')
	expect(instructions).not.toContain('Kody repository (for contributors)')
})

test('domain instruction blurbs truncate long descriptions', () => {
	const instructions = buildBaseMcpServerInstructions({
		domains: [
			{
				name: 'admin',
				description:
					'Admin-only operator capabilities for account metadata, platform accounts, package scope grants, fleet package-codemod scan/dry-run/apply/revert over published package trees, feature flags, and much more detail that should not all appear in always-loaded instructions.',
			},
		],
	})
	const line = instructions
		.split('\n')
		.find((entry) => entry.includes('`admin`'))
	expect(line).toBeTruthy()
	expect(line!.length).toBeLessThan(130)
	expect(line).toContain('...')
})
