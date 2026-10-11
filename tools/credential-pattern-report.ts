import { readFile } from 'node:fs/promises'
import {
	legacyCredentialPatternFromMessage,
	legacyCredentialPatterns,
	type LegacyCredentialPattern,
} from '../packages/worker/src/package-codemods/codemods/0010-detect-legacy-credential-patterns.ts'
import { isExecutedDirectly } from './node-runtime.ts'

export type CredentialScanItem = {
	userId: string
	packageId: string
	kodyId: string
	status: string
	findings: Array<{ path: string | null; message: string }>
}

type PatternCounts = Record<LegacyCredentialPattern, number>

export type CredentialPackageRow = {
	orgId: string
	packageId: string
	kodyId: string
	status: string
	/** Files per pattern. */
	patterns: Partial<PatternCounts>
}

export type CredentialPatternReport = {
	packagesScanned: number
	statusCounts: Record<string, number>
	/** Packages with at least one finding of the pattern. */
	packagesByPattern: PatternCounts
	/** Findings (one per file and pattern). */
	findingsByPattern: PatternCounts
	unknownFindings: number
	orgs: Array<{
		orgId: string
		packages: number
		packagesByPattern: Partial<PatternCounts>
	}>
	packages: Array<CredentialPackageRow>
}

function zeroCounts(): PatternCounts {
	return Object.fromEntries(
		legacyCredentialPatterns.map((pattern) => [pattern, 0]),
	) as PatternCounts
}

/** Accepts scan step results (`{ items }`) or bare items, in any nesting of arrays. */
export function collectScanItems(input: unknown): Array<CredentialScanItem> {
	if (Array.isArray(input)) return input.flatMap(collectScanItems)
	if (!input || typeof input !== 'object') return []
	const record = input as Record<string, unknown>
	if (Array.isArray(record.items)) return collectScanItems(record.items)
	if (typeof record.packageId === 'string' && Array.isArray(record.findings)) {
		return [record as unknown as CredentialScanItem]
	}
	return []
}

export function buildCredentialPatternReport(
	items: ReadonlyArray<CredentialScanItem>,
): CredentialPatternReport {
	const latestByPackage = new Map<string, CredentialScanItem>()
	for (const item of items) latestByPackage.set(item.packageId, item)

	const statusCounts: Record<string, number> = {}
	const packagesByPattern = zeroCounts()
	const findingsByPattern = zeroCounts()
	let unknownFindings = 0
	const packages: Array<CredentialPackageRow> = []
	for (const item of latestByPackage.values()) {
		statusCounts[item.status] = (statusCounts[item.status] ?? 0) + 1
		const patterns: Partial<PatternCounts> = {}
		for (const finding of item.findings) {
			const pattern = legacyCredentialPatternFromMessage(finding.message)
			if (pattern == null) {
				unknownFindings += 1
				continue
			}
			patterns[pattern] = (patterns[pattern] ?? 0) + 1
			findingsByPattern[pattern] += 1
		}
		for (const pattern of Object.keys(
			patterns,
		) as Array<LegacyCredentialPattern>) {
			packagesByPattern[pattern] += 1
		}
		if (Object.keys(patterns).length === 0) continue
		packages.push({
			orgId: item.userId,
			packageId: item.packageId,
			kodyId: item.kodyId,
			status: item.status,
			patterns,
		})
	}
	packages.sort(
		(left, right) =>
			left.orgId.localeCompare(right.orgId) ||
			left.kodyId.localeCompare(right.kodyId),
	)

	const orgMap = new Map<string, CredentialPatternReport['orgs'][number]>()
	for (const row of packages) {
		const org = orgMap.get(row.orgId) ?? {
			orgId: row.orgId,
			packages: 0,
			packagesByPattern: {},
		}
		org.packages += 1
		for (const pattern of Object.keys(
			row.patterns,
		) as Array<LegacyCredentialPattern>) {
			org.packagesByPattern[pattern] = (org.packagesByPattern[pattern] ?? 0) + 1
		}
		orgMap.set(row.orgId, org)
	}
	const orgs = [...orgMap.values()].sort(
		(left, right) =>
			right.packages - left.packages || left.orgId.localeCompare(right.orgId),
	)

	return {
		packagesScanned: latestByPackage.size,
		statusCounts,
		packagesByPattern,
		findingsByPattern,
		unknownFindings,
		orgs,
		packages,
	}
}

function table(header: Array<string>, rows: Array<Array<string | number>>) {
	return [
		`| ${header.join(' | ')} |`,
		`| ${header.map(() => '---').join(' | ')} |`,
		...rows.map((row) => `| ${row.map(String).join(' | ')} |`),
	].join('\n')
}

function escapeCell(value: string) {
	return value.replaceAll('|', '\\|')
}

export function formatCredentialPatternReport(report: CredentialPatternReport) {
	const patternHeader = legacyCredentialPatterns.map(escapeCell)
	return [
		'# Credential pattern scan (codemod 0010)',
		'',
		`Packages scanned: ${report.packagesScanned}. Packages with findings: ${report.packages.length}. Orgs with findings: ${report.orgs.length}.`,
		'',
		'## By status',
		'',
		table(
			['Status', 'Packages'],
			Object.entries(report.statusCounts).sort(([left], [right]) =>
				left.localeCompare(right),
			),
		),
		'',
		'## By pattern',
		'',
		table(
			['Pattern', 'Packages', 'Files'],
			legacyCredentialPatterns.map((pattern) => [
				escapeCell(pattern),
				report.packagesByPattern[pattern],
				report.findingsByPattern[pattern],
			]),
		),
		...(report.unknownFindings > 0
			? ['', `Findings with an unknown message: ${report.unknownFindings}.`]
			: []),
		'',
		'## By org (packages per pattern)',
		'',
		table(
			['Org id', 'Packages', ...patternHeader],
			report.orgs.map((org) => [
				org.orgId,
				org.packages,
				...legacyCredentialPatterns.map(
					(pattern) => org.packagesByPattern[pattern] ?? 0,
				),
			]),
		),
		'',
		'## By package (files per pattern)',
		'',
		table(
			['Org id', 'Package id', 'Package', 'Status', ...patternHeader],
			report.packages.map((row) => [
				row.orgId,
				row.packageId,
				row.kodyId,
				row.status,
				...legacyCredentialPatterns.map(
					(pattern) => row.patterns[pattern] ?? 0,
				),
			]),
		),
		'',
	].join('\n')
}

async function main() {
	const inputPath = process.argv[2]
	if (!inputPath) {
		throw new Error(
			'Usage: node tools/credential-pattern-report.ts <scan-items.json>',
		)
	}
	const items = collectScanItems(JSON.parse(await readFile(inputPath, 'utf8')))
	process.stdout.write(
		formatCredentialPatternReport(buildCredentialPatternReport(items)),
	)
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
