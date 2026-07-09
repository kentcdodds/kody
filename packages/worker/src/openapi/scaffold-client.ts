import { type OpenApiBoundAuth } from './auth-binding.ts'
import {
	type OpenApiHttpMethod,
	type OpenApiOperation,
	type ParsedOpenApiSpec,
} from './spec-types.ts'

export type ScaffoldedOperation = {
	slug: string
	exportName: string
	method: OpenApiHttpMethod
	path: string
}

export type OpenApiClientScaffold = {
	moduleSource: string
	operations: Array<ScaffoldedOperation>
	warnings: Array<string>
}

const SUMMARY_COMMENT_MAX = 120

export function scaffoldOpenApiClient(input: {
	spec: ParsedOpenApiSpec
	operationSlugs: Array<string>
	auth: OpenApiBoundAuth
	apiBaseUrl: string
	providerLabel?: string
}): OpenApiClientScaffold {
	const apiBaseUrl = trimTrailingSlash(input.apiBaseUrl)
	const warnings: Array<string> = []
	const bySlug = new Map(
		input.spec.operations.map((operation) => [operation.slug, operation]),
	)
	const selected: Array<OpenApiOperation> = []
	const seenSlugs = new Set<string>()

	for (const slug of input.operationSlugs) {
		if (seenSlugs.has(slug)) continue
		seenSlugs.add(slug)
		const operation = bySlug.get(slug)
		if (!operation) {
			warnings.push(`Unknown operation slug: ${slug}`)
			continue
		}
		selected.push(operation)
	}

	if (selected.length === 0) {
		throw new Error(
			'No resolvable operations for the given operationSlugs; cannot scaffold a client.',
		)
	}

	const usedExportNames = new Set<string>()
	const scaffolded: Array<
		ScaffoldedOperation & { operation: OpenApiOperation }
	> = selected.map((operation) => {
		const exportName = allocateExportName(operation.slug, usedExportNames)
		return {
			slug: operation.slug,
			exportName,
			method: operation.method,
			path: operation.path,
			operation,
		}
	})

	const moduleSource = [
		buildHeaderComment(input.spec, input.providerLabel),
		'',
		`const API_BASE_URL = ${JSON.stringify(apiBaseUrl)};`,
		'',
		buildSharedHelpers(),
		'',
		buildAuthSection(input.auth),
		'',
		...scaffolded.map((entry) =>
			buildOperationFunction(entry.exportName, entry.operation, input.auth),
		),
	].join('\n')

	return {
		moduleSource,
		operations: scaffolded.map(({ slug, exportName, method, path }) => ({
			slug,
			exportName,
			method,
			path,
		})),
		warnings,
	}
}

function trimTrailingSlash(url: string): string {
	return url.replace(/\/+$/, '')
}

function buildHeaderComment(
	spec: ParsedOpenApiSpec,
	providerLabel: string | undefined,
): string {
	const title = spec.title ?? 'Untitled'
	const version = spec.version ?? 'unknown'
	const labelLine =
		providerLabel === undefined
			? null
			: ` * Provider label: ${escapeBlockComment(providerLabel)}`
	return [
		'/**',
		' * Scaffolded by Kody from an OpenAPI spec.',
		` * Spec: ${escapeBlockComment(title)} v${escapeBlockComment(version)}`,
		...(labelLine === null ? [] : [labelLine]),
		" * Secret placeholders (e.g. {{secret:name}}) resolve via Kody's fetch gateway;",
		' * host approval is enforced there and is never widened by this spec.',
		' */',
	].join('\n')
}

function buildSharedHelpers(): string {
	return `
function buildUrl(pathTemplate, params = {}) {
	return API_BASE_URL + pathTemplate.replace(/\\{([^}]+)\\}/g, (_match, name) => {
		const value = params[name];
		if (value === undefined || value === null) {
			throw new Error(\`Missing required path parameter: \${name}\`);
		}
		return encodeURIComponent(String(value));
	});
}

function appendQuery(url, query = {}) {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null) continue;
		if (Array.isArray(value)) {
			for (const item of value) {
				if (item === undefined || item === null) continue;
				search.append(key, String(item));
			}
			continue;
		}
		search.append(key, String(value));
	}
	const qs = search.toString();
	return qs ? \`\${url}?\${qs}\` : url;
}

function mergeHeaders(userHeaders, authHeaders) {
	const merged = { ...(userHeaders ?? {}) };
	for (const [key, value] of Object.entries(authHeaders)) {
		// Auth headers always win; callers cannot override them.
		const lower = key.toLowerCase();
		for (const existing of Object.keys(merged)) {
			if (existing.toLowerCase() === lower) {
				delete merged[existing];
			}
		}
		merged[key] = value;
	}
	return merged;
}

function hasHeader(headers, name) {
	const lower = name.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}
`.trim()
}

function buildAuthSection(auth: OpenApiBoundAuth): string {
	switch (auth.kind) {
		case 'integration': {
			const provider = JSON.stringify(auth.provider)
			return `
// Integration auth: createAuthenticatedFetch is ambient in Kody execute/package sandboxes.
// Passing options.fetchImpl bypasses integration auth (useful for tests).
let __authedFetch = null;
async function resolveFetch(fetchImpl) {
	if (fetchImpl) return fetchImpl;
	if (!__authedFetch) {
		__authedFetch = await createAuthenticatedFetch(kody, ${provider});
	}
	return __authedFetch;
}

function authHeaders() {
	return {};
}
`.trim()
		}
		case 'bearerSecret':
		case 'headerSecret':
		case 'basicSecrets':
		case 'none':
			return `
async function resolveFetch(fetchImpl) {
	return fetchImpl ?? fetch;
}

function authHeaders() {
	return ${JSON.stringify(staticAuthHeaders(auth), null, '\t')};
}
`.trim()
		default: {
			const _exhaustive: never = auth
			return _exhaustive
		}
	}
}

function staticAuthHeaders(
	auth: Exclude<OpenApiBoundAuth, { kind: 'integration' }>,
): Record<string, string> {
	switch (auth.kind) {
		case 'bearerSecret':
			return {
				Authorization: `Bearer {{secret:${auth.secretName}}}`,
			}
		case 'headerSecret':
			return {
				[auth.headerName]: `{{secret:${auth.secretName}}}`,
			}
		case 'basicSecrets':
			return {
				Authorization: `{{secret-basic:username=${auth.usernameSecret},password=${auth.passwordSecret}}}`,
			}
		case 'none':
			return {}
		default: {
			const _exhaustive: never = auth
			return _exhaustive
		}
	}
}

function buildOperationFunction(
	exportName: string,
	operation: OpenApiOperation,
	auth: OpenApiBoundAuth,
): string {
	const pathParams = operation.parameters.filter((p) => p.location === 'path')
	const requiredPathParams = pathParams.filter((p) => p.required)
	const method = JSON.stringify(operation.method.toUpperCase())
	const pathLiteral = JSON.stringify(operation.path)
	const summary = truncateSummary(operation.summary)
	const contentType = operation.requestBody?.contentType ?? null
	const isJsonBody = contentType === null || isJsonContentType(contentType)

	const requiredChecks = requiredPathParams
		.map((param) => {
			const name = JSON.stringify(param.name)
			return [
				`\tif (params[${name}] === undefined || params[${name}] === null) {`,
				`\t\tthrow new Error(${JSON.stringify(`Missing required path parameter: ${param.name}`)});`,
				`\t}`,
			].join('\n')
		})
		.join('\n')

	const bodyLines = isJsonBody
		? [
				'\tlet body = undefined;',
				'\tconst headers = mergeHeaders(input.headers, authHeaders());',
				'\tif (input.body !== undefined) {',
				'\t\tbody = JSON.stringify(input.body);',
				'\t\tif (!hasHeader(headers, "content-type")) {',
				'\t\t\theaders["content-type"] = "application/json";',
				'\t\t}',
				'\t}',
			]
		: [
				'\t// Non-JSON request body content type from the OpenAPI operation; pass body through as-is.',
				'\tlet body = undefined;',
				'\tconst headers = mergeHeaders(input.headers, authHeaders());',
				'\tif (input.body !== undefined) {',
				'\t\tbody = input.body;',
				'\t\tif (!hasHeader(headers, "content-type")) {',
				`\t\t\theaders["content-type"] = ${JSON.stringify(contentType)};`,
				'\t\t}',
				'\t}',
			]

	const authNote =
		auth.kind === 'integration' ? ` (${escapeBlockComment(auth.provider)})` : ''
	const summaryNote =
		summary === null ? '' : ` — ${escapeBlockComment(summary)}`

	return [
		'/**',
		` * ${escapeBlockComment(operation.method.toUpperCase())} ${escapeBlockComment(operation.path)}${summaryNote}`,
		` * Auth: ${escapeBlockComment(auth.kind)}${authNote}`,
		' */',
		`export async function ${exportName}(input = {}, options = {}) {`,
		'\tconst params = input.params ?? {};',
		...(requiredChecks.length > 0 ? [requiredChecks] : []),
		`\tconst url = appendQuery(buildUrl(${pathLiteral}, params), input.query);`,
		...bodyLines,
		'\tconst fetchImpl = await resolveFetch(options.fetchImpl);',
		'\treturn fetchImpl(url, {',
		`\t\tmethod: ${method},`,
		'\t\theaders,',
		'\t\tbody,',
		'\t});',
		'}',
		'',
	].join('\n')
}

function isJsonContentType(contentType: string): boolean {
	const mediaType = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
	return (
		mediaType === 'application/json' ||
		mediaType === 'text/json' ||
		mediaType.endsWith('+json')
	)
}

function truncateSummary(summary: string | null): string | null {
	if (summary === null) return null
	const cleaned = summary.replace(/\s+/g, ' ').trim()
	if (cleaned.length === 0) return null
	if (cleaned.length <= SUMMARY_COMMENT_MAX) return cleaned
	return `${cleaned.slice(0, SUMMARY_COMMENT_MAX - 1)}…`
}

function escapeBlockComment(value: string): string {
	return value.replace(/\*\//g, '*\\/')
}

function allocateExportName(slug: string, used: Set<string>): string {
	const base = slugToCamelCase(slug)
	let candidate = base
	let suffix = 2
	while (used.has(candidate)) {
		candidate = `${base}${suffix}`
		suffix += 1
	}
	used.add(candidate)
	return candidate
}

function slugToCamelCase(slug: string): string {
	const parts = slug.split(/[^A-Za-z0-9]+/).filter((part) => part.length > 0)
	const [first, ...rest] = parts
	if (first === undefined) return 'operation'
	let name =
		first.toLowerCase() +
		rest
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
			.join('')
	if (!/^[A-Za-z_$]/.test(name)) {
		name = `op${name}`
	}
	// Reserved words that would break as function names
	if (isReservedWord(name)) {
		name = `${name}Fn`
	}
	return name
}

function isReservedWord(name: string): boolean {
	return /^(break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|false|finally|for|function|if|import|in|instanceof|new|null|return|super|switch|this|throw|true|try|typeof|var|void|while|with|yield|await|enum|implements|interface|let|package|private|protected|public|static)$/.test(
		name,
	)
}
