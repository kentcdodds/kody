import { z } from 'zod'
import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'
import {
	authoredPackageJsonSchema,
	type AuthoredPackageJson,
	type PackageExportTarget,
	type PackageRetrieverScope,
} from './types.ts'

const packageManifestPath = 'package.json'

function isScopedPackageName(name: string) {
	const trimmed = name.trim()
	if (!trimmed.startsWith('@')) {
		return false
	}

	const separator = trimmed.indexOf('/')
	return separator > 1 && separator < trimmed.length - 1
}

function getExpectedKodyName(name: string) {
	const trimmed = name.trim()
	const separator = trimmed.indexOf('/')
	return separator === -1 ? trimmed : trimmed.slice(separator + 1)
}

export function parseAuthoredPackageJson(input: {
	content: string
	manifestPath?: string
}): AuthoredPackageJson {
	let parsed: unknown
	try {
		parsed = JSON.parse(input.content)
	} catch (cause) {
		throw new Error(
			`Failed to parse ${input.manifestPath ?? packageManifestPath}: ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
		)
	}
	const result = authoredPackageJsonSchema.safeParse(parsed)
	if (!result.success) {
		const formatted = z.prettifyError(result.error)
		throw new Error(
			`Invalid ${input.manifestPath ?? packageManifestPath}:\n${formatted}`,
		)
	}

	const manifest = result.data
	if (!isScopedPackageName(manifest.name)) {
		throw new Error(
			`Invalid ${input.manifestPath ?? packageManifestPath}:\npackage.json name "${manifest.name}" must be a scoped package name like "@scope/${manifest.kody.id}".`,
		)
	}
	const expectedKodyId = getExpectedKodyName(manifest.name)
	if (expectedKodyId !== manifest.kody.id) {
		throw new Error(
			`Invalid ${input.manifestPath ?? packageManifestPath}:\npackage.json name "${manifest.name}" must use a leaf package name that matches kody.id "${manifest.kody.id}".`,
		)
	}

	return manifest
}

export function normalizePackageWorkspacePath(path: string) {
	return path.trim().replace(/^\.?\//, '')
}

function normalizePackageExportKey(exportName: string) {
	const trimmed = exportName.trim()
	if (!trimmed) {
		throw new Error('Package export name must not be empty.')
	}
	if (trimmed === '.' || trimmed === './') {
		return '.'
	}
	return trimmed.startsWith('./') ? trimmed : `./${trimmed}`
}

function readTargetPath(
	target: PackageExportTarget,
	purpose: 'runtime' | 'types',
): string | null {
	if (typeof target === 'string') {
		return purpose === 'runtime' ? target : null
	}
	if (purpose === 'types') {
		return target.types ?? null
	}
	return target.import ?? target.default ?? null
}

export function resolvePackageExportPath(input: {
	manifest: AuthoredPackageJson
	exportName: string
	purpose?: 'runtime' | 'types'
}) {
	const purpose = input.purpose ?? 'runtime'
	const normalizedExportKey = normalizePackageExportKey(input.exportName)
	const target = input.manifest.exports[normalizedExportKey]
	if (!target) {
		throw new Error(
			`Package "${input.manifest.kody.id}" does not define export "${normalizedExportKey}".`,
		)
	}
	const resolved = readTargetPath(target, purpose)
	if (!resolved) {
		throw new Error(
			`Package "${input.manifest.kody.id}" export "${normalizedExportKey}" does not define a ${purpose} target.`,
		)
	}
	return normalizePackageWorkspacePath(resolved)
}

export function getPackageAppEntryPath(manifest: AuthoredPackageJson) {
	const appEntry = manifest.kody.app?.entry?.trim()
	if (!appEntry) return null
	return normalizePackageWorkspacePath(appEntry)
}

export function getPackageServiceEntryPath(input: {
	manifest: AuthoredPackageJson
	serviceName: string
}) {
	const serviceEntry =
		input.manifest.kody.services?.[input.serviceName]?.entry?.trim()
	if (!serviceEntry) return null
	return normalizePackageWorkspacePath(serviceEntry)
}

export function listPackageServices(manifest: AuthoredPackageJson) {
	return Object.entries(manifest.kody.services ?? {})
		.map(([name, service]) => ({
			name,
			entry: normalizePackageWorkspacePath(service.entry),
			autoStart: service.autoStart ?? false,
			mode: service.mode ?? 'bounded',
			timeoutMs: service.timeoutMs ?? null,
		}))
		.sort((left, right) => left.name.localeCompare(right.name))
}

export function listPackageSubscriptions(manifest: AuthoredPackageJson) {
	return Object.entries(manifest.kody.subscriptions ?? {})
		.map(([topic, subscription]) => ({
			topic,
			handler: normalizePackageWorkspacePath(subscription.handler),
			description: subscription.description?.trim() || null,
			filters: subscription.filters ?? null,
		}))
		.sort((left, right) => left.topic.localeCompare(right.topic))
}

export type PackageRetrieverManifestEntry = {
	key: string
	exportName: string
	name: string
	description: string
	scopes: Array<PackageRetrieverScope>
	timeoutMs: number | null
	maxResults: number | null
}

export function listPackageRetrievers(
	manifest: AuthoredPackageJson,
): Array<PackageRetrieverManifestEntry> {
	return Object.entries(manifest.kody.retrievers ?? {})
		.map(([key, retriever]) => ({
			key,
			exportName: normalizePackageExportKey(retriever.export),
			name: retriever.name,
			description: retriever.description,
			scopes: Array.from(new Set(retriever.scopes)).sort(),
			timeoutMs: retriever.timeoutMs ?? null,
			maxResults: retriever.maxResults ?? null,
		}))
		.sort((left, right) => left.key.localeCompare(right.key))
}

export function getPackageTags(manifest: AuthoredPackageJson) {
	return [...(manifest.kody.tags ?? [])]
}

export type PackageExportFunctionProjection = {
	name: string
	description: string | null
	typeDefinition: string | null
}

export type PackageExportProjection = {
	subpath: string
	runtimeTarget: string | null
	typesPath: string | null
	description: string | null
	typeDefinition: string | null
	functions: Array<PackageExportFunctionProjection>
}

export type PackageSearchProjection = {
	name: string
	kodyId: string
	description: string
	tags: Array<string>
	searchText: string | null
	hasApp: boolean
	appEntry: string | null
	exports: Array<PackageExportProjection>
	jobs: Array<{
		name: string
		entry: string
		schedule: string
		enabled: boolean
	}>
	services: Array<{
		name: string
		entry: string
		autoStart: boolean
		mode: 'bounded' | 'persistent'
		timeoutMs: number | null
	}>
	subscriptions: Array<{
		topic: string
		handler: string
		description: string | null
		filters: Record<string, unknown> | null
	}>
	retrievers: Array<PackageRetrieverManifestEntry>
}

function getNodeStart(node: unknown) {
	if (!node || typeof node !== 'object') return null
	const start = (node as { start?: unknown }).start
	return typeof start === 'number' ? start : null
}

function getNodeEnd(node: unknown) {
	if (!node || typeof node !== 'object') return null
	const end = (node as { end?: unknown }).end
	return typeof end === 'number' ? end : null
}

function getNodeType(node: unknown) {
	const type = (node as { type?: unknown }).type
	return typeof type === 'string' ? type : null
}

function getProgramBody(program: unknown): Array<ModuleAstNode> {
	const root = program as {
		program?: { body?: unknown }
		body?: unknown
	}
	const body = root.program?.body ?? root.body
	return Array.isArray(body) ? (body as Array<ModuleAstNode>) : []
}

function normalizeJsDocComment(comment: string) {
	const trimmed = comment.trim()
	if (!trimmed.startsWith('/**')) return null
	return trimmed
		.replace(/^\/\*\*/, '')
		.replace(/\*\/$/, '')
		.split('\n')
		.map((line) => line.replace(/^\s*\*\s?/, '').trimEnd())
		.join('\n')
		.trim()
}

function readLeadingJsDoc(source: string, start: number) {
	const prefix = source.slice(0, start)
	const match = prefix.match(/\/\*\*(?:(?!\*\/)[\s\S])*\*\/\s*$/)
	if (!match) return null
	return normalizeJsDocComment(match[0] ?? '')
}

function readIdentifierName(node: unknown) {
	const name = (node as { name?: unknown }).name
	return typeof name === 'string' && name.trim() ? name : null
}

function getFunctionSignature(input: {
	source: string
	node: ModuleAstNode
	exportKeyword: string
}) {
	const start = getNodeStart(input.node)
	if (start == null) return null
	const bodyStart = getNodeStart((input.node as { body?: unknown }).body)
	const end = bodyStart ?? getNodeEnd(input.node)
	if (end == null) return null
	const signature = input.source
		.slice(start, end)
		.trim()
		.replace(/\s*\{$/, '')
		.replace(/\s*;\s*$/, '')
	return `${input.exportKeyword} ${signature}`.replace(/\s+/g, ' ').trim()
}

function formatParameterList(source: string, params: unknown) {
	if (!Array.isArray(params)) return ''
	return params
		.map((param) => {
			const start = getNodeStart(param)
			const end = getNodeEnd(param)
			return start == null || end == null
				? null
				: source.slice(start, end).trim()
		})
		.filter((param): param is string => param != null && param.length > 0)
		.join(', ')
}

function getReturnType(source: string, node: unknown) {
	const returnType = (node as { returnType?: unknown }).returnType
	const start = getNodeStart(returnType)
	const end = getNodeEnd(returnType)
	if (start == null || end == null) return 'unknown'
	return source.slice(start, end).replace(/^:\s*/, '').trim()
}

function getVariableFunctionSignature(input: {
	source: string
	declarator: ModuleAstNode
	exportKind: 'export' | 'export declare'
}) {
	const id = (input.declarator as { id?: unknown }).id
	const name = readIdentifierName(id)
	if (!name) return null
	const typeAnnotation = (id as { typeAnnotation?: unknown }).typeAnnotation
	const typeStart = getNodeStart(typeAnnotation)
	const typeEnd = getNodeEnd(typeAnnotation)
	if (typeStart != null && typeEnd != null) {
		return `${input.exportKind} const ${name}${input.source.slice(typeStart, typeEnd)}`
	}
	const init = (input.declarator as { init?: unknown }).init as
		| ModuleAstNode
		| undefined
	if (
		getNodeType(init) !== 'ArrowFunctionExpression' &&
		getNodeType(init) !== 'FunctionExpression'
	) {
		return null
	}
	const asyncPrefix =
		(init as { async?: unknown }).async === true ? 'async ' : ''
	const params = formatParameterList(
		input.source,
		(init as { params?: unknown }).params,
	)
	const returnType = getReturnType(input.source, init)
	return `${input.exportKind} ${asyncPrefix}function ${name}(${params}): ${returnType}`
}

function isFunctionDeclarator(declarator: ModuleAstNode) {
	const id = (declarator as { id?: unknown }).id
	if (!readIdentifierName(id)) return false
	const typeAnnotation = (id as { typeAnnotation?: unknown }).typeAnnotation
	if (typeAnnotation) return true
	const init = (declarator as { init?: unknown }).init
	return (
		getNodeType(init) === 'ArrowFunctionExpression' ||
		getNodeType(init) === 'FunctionExpression'
	)
}

function isFunctionDeclaration(node: unknown): node is ModuleAstNode {
	const type = getNodeType(node)
	return type === 'FunctionDeclaration' || type === 'TSDeclareFunction'
}

function collectExportedFunctionsFromSource(
	source: string,
): Array<PackageExportFunctionProjection> {
	let body: Array<ModuleAstNode>
	try {
		body = getProgramBody(parseModuleSource(source))
	} catch {
		return []
	}
	const functions: Array<PackageExportFunctionProjection> = []
	for (const statement of body) {
		if (statement.type === 'ExportDefaultDeclaration') {
			const declaration = (statement as { declaration?: unknown })
				.declaration as ModuleAstNode | undefined
			if (isFunctionDeclaration(declaration)) {
				const declarationStart = getNodeStart(declaration)
				functions.push({
					name: 'default',
					description:
						(declarationStart == null
							? null
							: readLeadingJsDoc(source, declarationStart)) ??
						(getNodeStart(statement) == null
							? null
							: readLeadingJsDoc(source, getNodeStart(statement) ?? 0)),
					typeDefinition: getFunctionSignature({
						source,
						node: declaration,
						exportKeyword: 'export default',
					}),
				})
			}
			continue
		}
		if (statement.type !== 'ExportNamedDeclaration') continue
		const declaration = (statement as { declaration?: unknown }).declaration as
			| ModuleAstNode
			| undefined
		const statementStart = getNodeStart(statement)
		const description =
			statementStart == null ? null : readLeadingJsDoc(source, statementStart)
		if (isFunctionDeclaration(declaration)) {
			const name = readIdentifierName((declaration as { id?: unknown }).id)
			if (!name) continue
			functions.push({
				name,
				description,
				typeDefinition: getFunctionSignature({
					source,
					node: declaration,
					exportKeyword: 'export',
				}),
			})
			continue
		}
		if (!declaration || getNodeType(declaration) !== 'VariableDeclaration') {
			continue
		}
		const declarations = (declaration as { declarations?: unknown })
			.declarations
		if (!Array.isArray(declarations)) continue
		for (const declarator of (declarations as Array<ModuleAstNode>).filter(
			isFunctionDeclarator,
		)) {
			const name = readIdentifierName((declarator as { id?: unknown }).id)
			if (!name) continue
			functions.push({
				name,
				description,
				typeDefinition: getVariableFunctionSignature({
					source,
					declarator,
					exportKind: source.includes('declare const')
						? 'export declare'
						: 'export',
				}),
			})
		}
	}
	return functions
}

function summarizePackageExport(input: {
	exportName: string
	target: PackageExportTarget
	files?: Record<string, string>
}): PackageExportProjection {
	const runtimeTarget = readTargetPath(input.target, 'runtime')
	const typesPath = readTargetPath(input.target, 'types')
	const runtimeSource = runtimeTarget
		? (input.files?.[normalizePackageWorkspacePath(runtimeTarget)] ?? null)
		: null
	const typesSource = typesPath
		? (input.files?.[normalizePackageWorkspacePath(typesPath)] ?? null)
		: null
	const functions = collectExportedFunctionsFromSource(
		typesSource ?? runtimeSource ?? '',
	)
	const [firstFunction] = functions
	return {
		subpath: normalizePackageExportKey(input.exportName),
		runtimeTarget: runtimeTarget
			? normalizePackageWorkspacePath(runtimeTarget)
			: null,
		typesPath: typesPath ? normalizePackageWorkspacePath(typesPath) : null,
		description: firstFunction?.description ?? null,
		typeDefinition:
			functions.length === 1 ? (firstFunction?.typeDefinition ?? null) : null,
		functions,
	}
}

export function buildPackageSearchProjection(
	manifest: AuthoredPackageJson,
	files?: Record<string, string>,
): PackageSearchProjection {
	const appEntry = getPackageAppEntryPath(manifest)
	return {
		name: manifest.name,
		kodyId: manifest.kody.id,
		description: manifest.kody.description,
		tags: getPackageTags(manifest),
		searchText: manifest.kody.searchText?.trim() || null,
		hasApp: appEntry !== null,
		appEntry,
		exports: Object.entries(manifest.exports)
			.map(([exportName, target]) =>
				summarizePackageExport({ exportName, target, files }),
			)
			.sort((left, right) => left.subpath.localeCompare(right.subpath)),
		jobs: Object.entries(manifest.kody.jobs ?? {})
			.map(([name, job]) => ({
				name,
				entry: normalizePackageWorkspacePath(job.entry),
				schedule:
					job.schedule.type === 'cron'
						? `cron:${job.schedule.expression}`
						: job.schedule.type === 'interval'
							? `interval:${job.schedule.every}`
							: `once:${job.schedule.runAt}`,
				enabled: job.enabled ?? true,
			}))
			.sort((left, right) => left.name.localeCompare(right.name)),
		services: listPackageServices(manifest),
		subscriptions: listPackageSubscriptions(manifest),
		retrievers: listPackageRetrievers(manifest),
	}
}

export function buildPackageSearchDocument(
	projection: PackageSearchProjection,
) {
	const jobLines = projection.jobs.map((job) =>
		[job.name, job.entry, job.schedule, job.enabled ? 'enabled' : 'disabled']
			.filter(
				(value): value is string =>
					typeof value === 'string' && value.length > 0,
			)
			.join(' '),
	)
	const serviceLines = projection.services.map((service) =>
		[
			service.name,
			service.entry,
			service.mode,
			service.autoStart ? 'auto-start' : 'manual-start',
			service.timeoutMs != null ? `timeout-ms:${service.timeoutMs}` : '',
		]
			.filter((value) => value.length > 0)
			.join(' '),
	)
	const subscriptionLines = (projection.subscriptions ?? []).map(
		(subscription) =>
			[
				`subscription:${subscription.topic}`,
				subscription.handler,
				subscription.description ?? '',
			]
				.filter((value) => value.length > 0)
				.join(' '),
	)
	const retrieverLines = projection.retrievers.map((retriever) =>
		[
			`retriever:${retriever.key}`,
			retriever.name,
			retriever.description,
			retriever.exportName,
			...retriever.scopes.map((scope) => `scope:${scope}`),
		]
			.filter((value) => value.length > 0)
			.join(' '),
	)
	const exportLines = projection.exports.map((exportDetail) => {
		const functions = Array.isArray(exportDetail.functions)
			? exportDetail.functions
			: []
		const values = [
			typeof exportDetail.subpath === 'string' ? exportDetail.subpath : '',
			typeof exportDetail.runtimeTarget === 'string'
				? exportDetail.runtimeTarget
				: '',
			typeof exportDetail.typesPath === 'string' ? exportDetail.typesPath : '',
			typeof exportDetail.description === 'string'
				? exportDetail.description
				: '',
			typeof exportDetail.typeDefinition === 'string'
				? exportDetail.typeDefinition
				: '',
			...functions.flatMap((fn) => [
				typeof fn.name === 'string' ? fn.name : '',
				typeof fn.description === 'string' ? fn.description : '',
				typeof fn.typeDefinition === 'string' ? fn.typeDefinition : '',
			]),
		]
		return [...values.filter((value) => value.length > 0)].join(' ')
	})
	return [
		`package ${projection.kodyId}`,
		projection.name,
		projection.description,
		projection.tags.join(' '),
		projection.searchText ?? '',
		exportLines.join('\n'),
		jobLines.join('\n'),
		serviceLines.join('\n'),
		subscriptionLines.join('\n'),
		retrieverLines.join('\n'),
		projection.appEntry
			? `app ${projection.appEntry}`
			: projection.hasApp
				? 'app'
				: '',
	]
		.filter((value) => value.trim().length > 0)
		.join('\n')
}
