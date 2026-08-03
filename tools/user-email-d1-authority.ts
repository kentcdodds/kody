import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'

const sharedGraphTables = new Set([
	'email_threads',
	'email_messages',
	'email_attachments',
	'email_delivery_events',
])

const mailboxSqlFiles = new Set([
	'packages/worker/src/email/mailbox-delivery-events.ts',
	'packages/worker/src/email/mailbox-do.ts',
	'packages/worker/src/email/mailbox-export.ts',
	'packages/worker/src/email/mailbox-inbound-bootstrap.ts',
	'packages/worker/src/email/mailbox-inbound-cleanup-ledger.ts',
	'packages/worker/src/email/mailbox-inbound-effect-ledger.ts',
	'packages/worker/src/email/mailbox-inbound-ledger-shared.ts',
	'packages/worker/src/email/mailbox-inbound-ledger.ts',
	'packages/worker/src/email/mailbox-message-deletion-tombstones.ts',
	'packages/worker/src/email/mailbox-mutations.ts',
	'packages/worker/src/email/mailbox-schema.ts',
	'packages/worker/src/email/mailbox-store.ts',
	'packages/worker/src/email/inbound-due-owners.ts',
])

const allowedSharedGraphSqlFiles = mailboxSqlFiles
const sharedGraphD1SqlFiles = new Set<string>()
const dynamicD1SqlFiles = new Set([
	'packages/worker/src/email/system-email-authority.ts',
	'packages/worker/src/email/system-email-graph-store.ts',
	'packages/worker/src/email/system-email.ts',
])

const allowedRepoImports = new Set([
	'createEmailInbox',
	'createEmailInboxAddress',
	'deleteEmailInboxAddressById',
	'ensurePlatformSenderIdentity',
	'getEmailInboxAddressByAddress',
	'getEmailInboxById',
	'getEmailInboxByName',
	'listEmailInboxAddressesForUser',
	'listEmailInboxesForUser',
])

const additionalAllowedRepoImports = new Map([
	[
		'packages/worker/src/email/system-email-graph-store.ts',
		new Set([
			'EmailInboundDeliveryFence',
			'boundedEmailBody',
			'emailRawMimeKey',
			'mapAttachmentRow',
			'mapMessageRow',
			'mapThreadRow',
		]),
	],
	['packages/worker/src/email/system-email.ts', new Set(['emailRawMimeKey'])],
])

const retiredLegacyEmailModules = new Set([
	'legacy-user-email-graph-cleanup',
	'mailbox-live-mirror',
	'mailbox-mirror',
	'mailbox-parity-repo',
	'mailbox-snapshot-repo',
	'mailbox-snapshots',
	'system-email-graph-repo',
	'system-email-graph-sql',
	'system-email-graph-transaction',
	'system-inbound-delivery-mirror',
	'user-email-d1-guard',
])

function isTestFile(file: string) {
	return (
		file.includes('.test.') ||
		file.endsWith('/test-schema.ts') ||
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

const sqlIdentifier =
	'(?:[A-Za-z_][A-Za-z0-9_]*|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\\[(?:[^\\]]|\\]\\])*\\]|\'(?:[^\']|\'\')*\')'
const sqlRelation = new RegExp(
	`\\b(?:FROM|JOIN|INTO|UPDATE|TABLE|REFERENCES|ON)\\s+` +
		`(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?` +
		`(${sqlIdentifier}(?:\\s*\\.\\s*${sqlIdentifier})?)`,
	'giu',
)
const sqlIdentifierToken = new RegExp(sqlIdentifier, 'gu')

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

function sharedTablesInSql(value: string) {
	const tables = new Set<string>()
	for (const match of value.matchAll(sqlRelation)) {
		const identifiers = match[1]?.match(sqlIdentifierToken) ?? []
		const table = identifiers.at(-1)
		if (table == null) continue
		const normalized = normalizeSqlIdentifier(table)
		if (sharedGraphTables.has(normalized)) tables.add(normalized)
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

function isStaticSqlLiteral(node: ts.Node) {
	return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
}

type LegacyEmailModule = 'repo' | 'retired'

function legacyEmailModule(
	file: string,
	value: string,
): LegacyEmailModule | null {
	const normalized = value.replace(/\.tsx?$/u, '')
	const isEmailRelative =
		normalized.startsWith('.') && file.startsWith('packages/worker/src/email/')
	const isEmailAlias =
		normalized.startsWith('#worker/email/') || normalized.includes('/email/')
	if (!isEmailRelative && !isEmailAlias) return null
	const name = normalized.split('/').at(-1)
	if (name === 'repo') return 'repo'
	return name != null && retiredLegacyEmailModules.has(name) ? 'retired' : null
}

export type UserEmailD1AuthorityViolation = {
	file: string
	line: number
	message: string
}

export async function scanUserEmailD1Authority(
	root: string = process.cwd(),
): Promise<Array<UserEmailD1AuthorityViolation>> {
	const sourceRoot = path.join(root, 'packages', 'worker', 'src')
	const files = await listTypeScriptFiles(sourceRoot)
	const violations: Array<UserEmailD1AuthorityViolation> = []
	for (const absolute of files) {
		const file = path.relative(root, absolute).replaceAll(path.sep, '/')
		if (isTestFile(file)) continue
		const text = await readFile(absolute, 'utf8')
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
			violations.push({ file, line, message })
		}
		const reportLegacyImport = (
			node: ts.Node,
			moduleKind: LegacyEmailModule,
			imported: string,
		) => {
			if (moduleKind === 'retired') {
				report(node, `live module imports retired email module "${imported}"`)
				return
			}
			const allowed =
				allowedRepoImports.has(imported) ||
				additionalAllowedRepoImports.get(file)?.has(imported) === true
			if (!allowed) {
				report(
					node,
					`live module imports legacy email repo mutator "${imported}"`,
				)
			}
		}
		const visit = (node: ts.Node) => {
			const value = stringValue(node)
			if (value != null && !allowedSharedGraphSqlFiles.has(file)) {
				const tables = sharedTablesInSql(value)
				if (tables.length > 0) {
					report(
						node,
						`shared USER graph SQL outside the exact static allowlist: ${tables.join(', ')}`,
					)
				}
			}
			if (
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression) &&
				(node.expression.name.text === 'prepare' ||
					node.expression.name.text === 'exec')
			) {
				const sqlNode = node.arguments[0]
				const sql = sqlNode ? stringValue(sqlNode) : null
				const tables = sql == null ? [] : sharedTablesInSql(sql)
				const receiver = node.expression.expression.getText(source)
				const mailboxSql =
					mailboxSqlFiles.has(file) &&
					(receiver === 'sql' || receiver.endsWith('.sql'))
				const liveEmailD1Boundary = file.startsWith(
					'packages/worker/src/email/',
				)
				if (
					sqlNode != null &&
					!isStaticSqlLiteral(sqlNode) &&
					liveEmailD1Boundary &&
					!mailboxSql &&
					!dynamicD1SqlFiles.has(file)
				) {
					report(
						sqlNode,
						'live D1 prepare/exec SQL must be an inline string literal; dynamic SQL can conceal shared USER graph access',
					)
				}
				if (
					tables.length > 0 &&
					!mailboxSql &&
					!sharedGraphD1SqlFiles.has(file)
				) {
					report(
						sqlNode ?? node,
						`shared USER graph D1 SQL remains in production code: ${tables.join(', ')}`,
					)
				}
			}
			if (
				ts.isCallExpression(node) &&
				(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
					(ts.isIdentifier(node.expression) &&
						node.expression.text === 'require')) &&
				node.arguments[0] != null &&
				ts.isStringLiteral(node.arguments[0])
			) {
				const moduleKind = legacyEmailModule(file, node.arguments[0].text)
				if (moduleKind != null) {
					reportLegacyImport(node, moduleKind, '*dynamic*')
				}
			}
			if (
				ts.isImportDeclaration(node) &&
				node.moduleSpecifier != null &&
				ts.isStringLiteral(node.moduleSpecifier)
			) {
				const moduleKind = legacyEmailModule(file, node.moduleSpecifier.text)
				if (moduleKind != null) {
					const clause = node.importClause
					if (clause == null) {
						reportLegacyImport(node, moduleKind, '*side-effect*')
					} else {
						if (clause.name != null) {
							reportLegacyImport(clause.name, moduleKind, 'default')
						}
						const bindings = clause.namedBindings
						if (bindings != null && ts.isNamespaceImport(bindings)) {
							reportLegacyImport(bindings, moduleKind, '*namespace*')
						} else if (bindings != null) {
							for (const element of bindings.elements) {
								const imported = element.propertyName?.text ?? element.name.text
								reportLegacyImport(element, moduleKind, imported)
							}
						}
					}
				}
			}
			if (
				ts.isExportDeclaration(node) &&
				node.moduleSpecifier != null &&
				ts.isStringLiteral(node.moduleSpecifier)
			) {
				const moduleKind = legacyEmailModule(file, node.moduleSpecifier.text)
				if (moduleKind != null) {
					const bindings = node.exportClause
					if (bindings == null || !ts.isNamedExports(bindings)) {
						reportLegacyImport(node, moduleKind, '*re-export*')
					} else {
						for (const element of bindings.elements) {
							const imported = element.propertyName?.text ?? element.name.text
							reportLegacyImport(element, moduleKind, imported)
						}
					}
				}
			}
			if (
				ts.isImportEqualsDeclaration(node) &&
				ts.isExternalModuleReference(node.moduleReference) &&
				node.moduleReference.expression != null &&
				ts.isStringLiteral(node.moduleReference.expression)
			) {
				const moduleKind = legacyEmailModule(
					file,
					node.moduleReference.expression.text,
				)
				if (moduleKind != null) {
					reportLegacyImport(node, moduleKind, '*import-equals*')
				}
			}
			ts.forEachChild(node, visit)
		}
		visit(source)
	}
	return violations
}
