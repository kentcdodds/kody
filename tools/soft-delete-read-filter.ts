import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import { isExecutedDirectly } from './node-runtime.ts'
import { isSoftDeleteTable } from '../packages/worker/src/soft-delete/tables.ts'
import { softDeleteReadFilterOptOutMarker } from '../packages/worker/src/soft-delete/live-sql.ts'

/** Grandfather set for production scan (must only shrink). Empty until rollout. */
export const softDeleteReadFilterAllowlist = new Set<string>()

const scanRoots = ['packages/worker/src', 'packages/jobs-worker/src'] as const

const sqlIdentifier =
	'(?:[A-Za-z_][A-Za-z0-9_]*|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\\[(?:[^\\]]|\\]\\])*\\]|\'(?:[^\']|\'\')*\')'
const sqlRelation = new RegExp(
	`\\b(?:FROM|JOIN|INTO|UPDATE|TABLE|REFERENCES|ON)\\s+` +
		`(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?` +
		`(${sqlIdentifier}(?:\\s*\\.\\s*${sqlIdentifier})?)`,
	'giu',
)
const sqlIdentifierToken = new RegExp(sqlIdentifier, 'gu')

const liveDeletedAtInSql = /\b(?:[\w"'`[\].]+?\.)?deleted_at\s+IS\s+NULL\b/i

function normalizeSqlIdentifier(value: string) {
	const trimmed = value.trim()
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith('`') && trimmed.endsWith('`')) ||
		(trimmed.startsWith('[') && trimmed.endsWith(']')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		const close = trimmed.at(-1) ?? ''
		return trimmed
			.slice(1, -1)
			.replaceAll(close + close, close)
			.toLowerCase()
	}
	return trimmed.toLowerCase()
}

function softDeleteTablesInSql(value: string) {
	const tables = new Set<string>()
	for (const match of value.matchAll(sqlRelation)) {
		const identifiers = match[1]?.match(sqlIdentifierToken) ?? []
		const table = identifiers.at(-1)
		if (table == null) continue
		const normalized = normalizeSqlIdentifier(table)
		if (isSoftDeleteTable(normalized)) tables.add(normalized)
	}
	return [...tables]
}

function stringValue(node: ts.Node): string | null {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
		return node.text
	}
	if (ts.isTemplateExpression(node)) {
		return [
			node.head.text,
			...node.templateSpans.map((span) => span.literal.text),
		].join(' ')
	}
	return null
}

function templateUsesLiveDeletedAtHelper(node: ts.TemplateExpression): boolean {
	for (const span of node.templateSpans) {
		const expr = span.expression
		if (ts.isCallExpression(expr)) {
			const name = callExpressionName(expr)
			if (
				name === 'liveDeletedAtSql' ||
				name === 'andLiveDeletedAtSql' ||
				name === 'withLiveDeletedAt'
			) {
				return true
			}
		}
	}
	return false
}

function callExpressionName(node: ts.CallExpression): string | null {
	const { expression } = node
	if (ts.isIdentifier(expression)) return expression.text
	if (ts.isPropertyAccessExpression(expression)) {
		return expression.name.text
	}
	return null
}

function primaryStatementKind(
	sql: string,
): 'select' | 'insert' | 'update' | 'delete' {
	const normalized = sql.trimStart()
	if (/^DELETE\b/i.test(normalized)) return 'delete'
	if (/^INSERT\b/i.test(normalized)) return 'insert'
	if (/^UPDATE\b/i.test(normalized)) return 'update'
	return 'select'
}

function isSoftDeleteClaimUpdate(sql: string): boolean {
	if (!/^UPDATE\b/is.test(sql.trimStart())) return false
	const setMatch = /\bSET\b([\s\S]*?)(?:\bWHERE\b|$)/i.exec(sql)
	if (setMatch == null) return false
	const assignments = setMatch[1] ?? ''
	const parts = assignments.split(',').map((part) => part.trim())
	if (parts.length === 0 || parts.some((part) => part === '')) return false
	for (const part of parts) {
		const column = part.split('=')[0]?.trim() ?? ''
		const normalized = normalizeSqlIdentifier(
			column.split('.').at(-1) ?? column,
		)
		if (normalized !== 'deleted_at' && normalized !== 'deleting_at') {
			return false
		}
	}
	return true
}

function sqlHasLiveDeletedFilter(
	sql: string | null,
	sqlNode: ts.Node | undefined,
): boolean {
	if (sql != null && liveDeletedAtInSql.test(sql)) return true
	if (sqlNode != null && ts.isTemplateExpression(sqlNode)) {
		return templateUsesLiveDeletedAtHelper(sqlNode)
	}
	return false
}

function isTestFile(file: string) {
	return (
		file.includes('.test.') ||
		file.endsWith('/test-schema.ts') ||
		file.endsWith('-test-schema.ts') ||
		file.includes('/test-support/')
	)
}

async function listTypeScriptFiles(directory: string): Promise<Array<string>> {
	const entries = await readdir(directory, { withFileTypes: true })
	const files: Array<string> = []
	for (const entry of entries) {
		const absolute = path.join(directory, entry.name)
		if (entry.isDirectory()) {
			files.push(...(await listTypeScriptFiles(absolute)))
		} else if (
			entry.isFile() &&
			(entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
		) {
			files.push(absolute)
		}
	}
	return files
}

export type SoftDeleteReadFilterViolation = {
	file: string
	line: number
	message: string
}

function violationKey(violation: SoftDeleteReadFilterViolation): string {
	return `${violation.file}:${violation.line}`
}

function isAllowlisted(violation: SoftDeleteReadFilterViolation): boolean {
	if (softDeleteReadFilterAllowlist.size === 0) return false
	const key = violationKey(violation)
	if (softDeleteReadFilterAllowlist.has(key)) return true
	return softDeleteReadFilterAllowlist.has(violation.file)
}

export async function scanSoftDeleteReadFilter(
	root: string = process.cwd(),
): Promise<Array<SoftDeleteReadFilterViolation>> {
	const violations: Array<SoftDeleteReadFilterViolation> = []
	for (const scanRoot of scanRoots) {
		const sourceRoot = path.join(root, scanRoot)
		let files: Array<string>
		try {
			files = await listTypeScriptFiles(sourceRoot)
		} catch {
			continue
		}
		for (const absolute of files) {
			const file = path.relative(root, absolute).replaceAll(path.sep, '/')
			if (isTestFile(file)) continue
			const text = await readFile(absolute, 'utf8')
			const fileOptOut = text.includes(softDeleteReadFilterOptOutMarker)
			const source = ts.createSourceFile(
				file,
				text,
				ts.ScriptTarget.Latest,
				true,
				file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
			)
			const report = (node: ts.Node, message: string) => {
				const line =
					source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
				const violation = { file, line, message }
				if (!isAllowlisted(violation)) {
					violations.push(violation)
				}
			}
			const visit = (node: ts.Node) => {
				if (
					ts.isCallExpression(node) &&
					ts.isPropertyAccessExpression(node.expression) &&
					(node.expression.name.text === 'prepare' ||
						node.expression.name.text === 'exec')
				) {
					const sqlNode = node.arguments[0]
					const sql = sqlNode ? stringValue(sqlNode) : null
					const tables = sql == null ? [] : softDeleteTablesInSql(sql)
					if (tables.length === 0) {
						ts.forEachChild(node, visit)
						return
					}
					if (fileOptOut) {
						ts.forEachChild(node, visit)
						return
					}
					const hasFilter = sqlHasLiveDeletedFilter(sql, sqlNode)
					const kind = sql == null ? 'select' : primaryStatementKind(sql)
					if (kind === 'insert') {
						ts.forEachChild(node, visit)
						return
					}
					if (kind === 'delete') {
						if (!hasFilter) {
							report(
								sqlNode ?? node,
								`DELETE on soft-delete table(s) ${tables.join(', ')} requires file opt-out or deleted_at IS NULL filter (purge lane only)`,
							)
						}
						ts.forEachChild(node, visit)
						return
					}
					if (kind === 'update') {
						if (sql != null && isSoftDeleteClaimUpdate(sql)) {
							ts.forEachChild(node, visit)
							return
						}
						if (!hasFilter) {
							report(
								sqlNode ?? node,
								`live read/update SQL on soft-delete table(s) ${tables.join(', ')} must include deleted_at IS NULL or liveDeletedAtSql helper`,
							)
						}
						ts.forEachChild(node, visit)
						return
					}
					if (!hasFilter) {
						report(
							sqlNode ?? node,
							`SELECT on soft-delete table(s) ${tables.join(', ')} must include deleted_at IS NULL or liveDeletedAtSql helper`,
						)
					}
				}
				ts.forEachChild(node, visit)
			}
			visit(source)
		}
	}
	return violations
}

export async function main(cwd: string = process.cwd()): Promise<void> {
	const violations = await scanSoftDeleteReadFilter(cwd)
	const actionable = violations.filter((violation) => !isAllowlisted(violation))
	if (actionable.length === 0) {
		console.log('Soft-delete read-filter check passed.')
		return
	}
	console.error(
		[
			`Soft-delete read-filter check failed (${String(actionable.length)} issue(s)).`,
			'Live SQL on soft-delete tables must include deleted_at IS NULL (or liveDeletedAtSql helpers).',
			'Purge/restore writers may opt out with soft-delete-read-filter: opt-out.',
			'',
			...actionable.map(
				(violation) =>
					`${violation.file}:${String(violation.line)}: ${violation.message}`,
			),
		].join('\n'),
	)
	process.exitCode = 1
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
