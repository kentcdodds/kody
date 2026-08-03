import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'

const sharedGraphTables = new Set([
	'email_threads',
	'email_messages',
	'email_attachments',
	'email_delivery_events',
])

const explicitSharedGraphReferenceFiles = new Set([
	'packages/worker/src/account/data-targets.ts',
	'packages/worker/src/account/user-owned-surfaces.ts',
	'packages/worker/src/app/account-retention-dispositions.ts',
	'packages/worker/src/email/inbound-due-owners.ts',
	'packages/worker/src/email/legacy-user-email-graph-cleanup.ts',
	'packages/worker/src/email/outbound-provider-index.ts',
	'packages/worker/src/email/user-email-d1-guard.ts',
])

const sharedGraphD1SqlFiles = new Set([
	'packages/worker/src/email/legacy-user-email-graph-cleanup.ts',
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

function isTestFile(file: string) {
	return file.includes('.test.') || file.endsWith('/test-schema.ts')
}

function isAllowedSharedGraphFile(file: string) {
	return (
		explicitSharedGraphReferenceFiles.has(file) ||
		file.startsWith('packages/worker/src/email/mailbox-') ||
		file.startsWith('packages/worker/src/email/system-')
	)
}

function isAllowedSharedGraphD1SqlFile(file: string) {
	return (
		sharedGraphD1SqlFiles.has(file) ||
		file.startsWith('packages/worker/src/email/system-')
	)
}

function isMailboxSqlFile(file: string) {
	return (
		file.startsWith('packages/worker/src/email/mailbox-') ||
		file === 'packages/worker/src/email/inbound-due-owners.ts'
	)
}

async function listTypeScriptFiles(directory: string): Promise<Array<string>> {
	const entries = await readdir(directory, { withFileTypes: true })
	const files: Array<string> = []
	for (const entry of entries) {
		const absolute = path.join(directory, entry.name)
		if (entry.isDirectory()) {
			files.push(...(await listTypeScriptFiles(absolute)))
		} else if (entry.isFile() && entry.name.endsWith('.ts')) {
			files.push(absolute)
		}
	}
	return files
}

function sharedTablesInLiteral(value: string) {
	const tokens = value.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []
	return [...new Set(tokens.filter((token) => sharedGraphTables.has(token)))]
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

function repoModuleSpecifier(file: string, value: string) {
	return (
		(value === './repo.ts' && file.startsWith('packages/worker/src/email/')) ||
		value.endsWith('/email/repo.ts')
	)
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
			ts.ScriptKind.TS,
		)
		const report = (node: ts.Node, message: string) => {
			const line =
				source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
			violations.push({ file, line, message })
		}
		const visit = (node: ts.Node) => {
			const value = stringValue(node)
			if (value != null && !isAllowedSharedGraphFile(file)) {
				const tables = sharedTablesInLiteral(value)
				if (tables.length > 0) {
					report(
						node,
						`shared USER graph reference outside the static allowlist: ${tables.join(', ')}`,
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
				const tables = sql == null ? [] : sharedTablesInLiteral(sql)
				const receiver = node.expression.expression.getText(source)
				const mailboxSql =
					isMailboxSqlFile(file) &&
					(receiver === 'sql' || receiver.endsWith('.sql'))
				if (
					tables.length > 0 &&
					!mailboxSql &&
					!isAllowedSharedGraphD1SqlFile(file)
				) {
					report(
						sqlNode ?? node,
						`shared USER graph D1 SQL outside cleanup/system rollback boundary: ${tables.join(', ')}`,
					)
				}
			}
			if (
				(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
				node.moduleSpecifier != null &&
				ts.isStringLiteral(node.moduleSpecifier) &&
				repoModuleSpecifier(file, node.moduleSpecifier.text) &&
				!file.startsWith('packages/worker/src/email/system-')
			) {
				const bindings = ts.isImportDeclaration(node)
					? node.importClause?.namedBindings
					: node.exportClause
				if (
					bindings &&
					(ts.isNamedImports(bindings) || ts.isNamedExports(bindings))
				) {
					for (const element of bindings.elements) {
						const imported = element.propertyName?.text ?? element.name.text
						if (!allowedRepoImports.has(imported)) {
							report(
								element,
								`live module imports legacy email repo mutator "${imported}"`,
							)
						}
					}
				}
			}
			ts.forEachChild(node, visit)
		}
		visit(source)
	}
	return violations
}
