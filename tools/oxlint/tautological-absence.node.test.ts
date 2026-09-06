import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, test } from 'vitest'
// @ts-expect-error - the oxlint helper is plain JS with no type declarations.
import {
	checkTautologicalAbsence,
	findTautologicalAbsenceMatches,
	isInstructionalCopyNeedle,
	longestCommonPrefixLength,
	siblingPrefixLength,
} from './tautological-absence.js'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const vanishedCopy = 'The vanished owner subtitle belongs here.'
// Split so this test file is not itself a haystack hit for the oxlint fixture.
const oxlintWiringSentinel = [
	'Zzyzx oxlint vanished-copy wiring',
	'sentinel belongs nowhere else.',
].join(' ')

test('isInstructionalCopyNeedle keeps prose and skips markup, urls, and short ids', () => {
	expect(
		isInstructionalCopyNeedle(
			'The vanished owner subtitle belongs here.',
			'The vanished owner subtitle belongs here.',
		),
	).toBe(true)
	expect(isInstructionalCopyNeedle('Download PNG', 'Download PNG')).toBe(true)
	expect(isInstructionalCopyNeedle('stored-hash', 'stored-hash')).toBe(false)
	expect(isInstructionalCopyNeedle('>App icon<', '>App icon<')).toBe(false)
	expect(isInstructionalCopyNeedle('.card &gt; p', '.card &gt; p')).toBe(false)
	expect(isInstructionalCopyNeedle('You’re home', 'You\\u2019re home')).toBe(
		false,
	)
	expect(
		isInstructionalCopyNeedle(
			'https://evil.example/path',
			'https://evil.example/path',
		),
	).toBe(false)
})

test('longestCommonPrefixLength measures sibling template families', () => {
	expect(
		longestCommonPrefixLength(
			'Help me use Kody with x.com.',
			'Help me use Kody with X.',
		),
	).toBeGreaterThanOrEqual(siblingPrefixLength)
	expect(
		longestCommonPrefixLength(
			'The vanished owner subtitle belongs here.',
			'Edit profile',
		),
	).toBeLessThan(siblingPrefixLength)
})

test('findTautologicalAbsenceMatches flags a lone vanished copy needle', () => {
	expect(
		findTautologicalAbsenceMatches({
			relativePath: 'packages/worker/client/routes/profile.node.test.ts',
			content: [
				"expect(ownHtml).toContain('Edit profile')",
				`expect(ownHtml).not.toContain('${vanishedCopy}')`,
			].join('\n'),
			otherContents: ["export const label = 'Edit profile'\n"],
		}),
	).toEqual([
		expect.objectContaining({
			line: 2,
			needle: vanishedCopy,
		}),
	])
})

test('findTautologicalAbsenceMatches keeps state flips and live production copy', () => {
	const stateFlip = findTautologicalAbsenceMatches({
		relativePath: 'packages/worker/client/routes/profile.node.test.ts',
		content: [
			"expect(ownHtml).toContain('Connect your agent')",
			"expect(guestHtml).not.toContain('Connect your agent')",
		].join('\n'),
		otherContents: [],
	})
	expect(stateFlip).toEqual([])

	const stillInSource = findTautologicalAbsenceMatches({
		relativePath: 'packages/worker/client/routes/profile.node.test.ts',
		content: "expect(ownHtml).not.toContain('Connect your agent')\n",
		otherContents: ['export const onboardingTitle = "Connect your agent"\n'],
	})
	expect(stillInSource).toEqual([])
})

test('findTautologicalAbsenceMatches keeps wrong-template siblings and fixtures', () => {
	const sibling = findTautologicalAbsenceMatches({
		relativePath: 'packages/worker/client/routes/onboarding.node.test.ts',
		content: [
			"expect(html).toContain('Help me use Kody with x.com.')",
			"expect(html).not.toContain('Help me use Kody with X.')",
		].join('\n'),
		otherContents: [],
	})
	expect(sibling).toEqual([])

	const fixture = findTautologicalAbsenceMatches({
		relativePath: 'packages/worker/src/mcp/search.node.test.ts',
		content: [
			"const title = 'Connect an agent'",
			"expect(ranked).not.toContain('Connect an agent')",
		].join('\n'),
		otherContents: [],
	})
	expect(fixture).toEqual([])
})

test('findTautologicalAbsenceMatches flags the same vanished copy in two test files', () => {
	const first = [
		"expect(ownHtml).toContain('Edit profile')",
		`expect(ownHtml).not.toContain('${vanishedCopy}')`,
		'',
	].join('\n')
	const second = `expect(guestHtml).not.toContain('${vanishedCopy}')\n`

	expect(
		findTautologicalAbsenceMatches({
			relativePath: 'packages/worker/client/routes/profile.node.test.ts',
			content: first,
			otherContents: [second],
		}),
	).toEqual([
		expect.objectContaining({
			file: 'packages/worker/client/routes/profile.node.test.ts',
			needle: vanishedCopy,
		}),
	])
	expect(
		findTautologicalAbsenceMatches({
			relativePath: 'packages/worker/client/routes/guest.node.test.ts',
			content: second,
			otherContents: [first],
		}),
	).toEqual([
		expect.objectContaining({
			file: 'packages/worker/client/routes/guest.node.test.ts',
			needle: vanishedCopy,
		}),
	])
})

test('checkTautologicalAbsence scans test files against the rest of the tree', async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), 'tautological-absence-'))
	try {
		const routesDir = path.join(cwd, 'packages', 'worker', 'client', 'routes')
		await mkdir(routesDir, { recursive: true })
		await Promise.all([
			writeFile(
				path.join(routesDir, 'profile.tsx'),
				'export const label = "Edit profile"\n',
			),
			writeFile(
				path.join(routesDir, 'profile.node.test.ts'),
				[
					"expect(ownHtml).toContain('Edit profile')",
					`expect(ownHtml).not.toContain('${vanishedCopy}')`,
					'',
				].join('\n'),
			),
		])

		expect(checkTautologicalAbsence(cwd)).toEqual([
			expect.objectContaining({
				file: 'packages/worker/client/routes/profile.node.test.ts',
				line: 2,
				needle: vanishedCopy,
			}),
		])
	} finally {
		await rm(cwd, { recursive: true, force: true })
	}
})

test('oxlint reports vanished instructional copy from kody-custom/no-tautological-absence', async () => {
	const fixturePath = path.join(
		os.tmpdir(),
		`tautological-absence-${String(process.pid)}.node.test.ts`,
	)
	await writeFile(
		fixturePath,
		[
			"import { expect, test } from 'vitest'",
			'test("vanished copy", () => {',
			`	expect(html).not.toContain(${JSON.stringify(oxlintWiringSentinel)})`,
			'})',
			'',
		].join('\n'),
	)
	try {
		const result = spawnSync(
			path.join(repoRoot, 'node_modules', 'oxlint', 'bin', 'oxlint'),
			[fixturePath],
			{ cwd: repoRoot, encoding: 'utf8' },
		)
		const output = `${result.stdout}\n${result.stderr}`
		expect(output).toContain('no-tautological-absence')
		expect(output).toContain(oxlintWiringSentinel)
		expect(result.status).not.toBe(0)
	} finally {
		await rm(fixturePath, { force: true })
	}
})
