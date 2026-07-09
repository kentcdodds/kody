import {
	type OpenApiHttpMethod,
	type OpenApiOperation,
	type OpenApiSecurityScheme,
	type OpenApiServer,
	type ParsedOpenApiSpec,
} from './spec-types.ts'

export type OpenApiAuthSuggestion = {
	schemeName: string
	type: OpenApiSecurityScheme['type']
	detail: string
	kodyAuthPath: string
}

export type OpenApiOperationSummary = {
	operationId: string | null
	slug: string
	method: OpenApiHttpMethod
	path: string
	summary: string | null
	tags: Array<string>
	deprecated: boolean
}

export type OpenApiSpecSummary = {
	title: string | null
	version: string | null
	openapiVersion: string
	servers: Array<OpenApiServer>
	suggestedApiBaseUrl: string | null
	suggestedHosts: Array<string>
	auth: Array<OpenApiAuthSuggestion>
	defaultSecuritySchemeNames: Array<string>
	suggestedSmokeTestOperations: Array<
		OpenApiOperationSummary & { reason: string }
	>
	operations: Array<OpenApiOperationSummary>
	operationCount: number
	truncated: boolean
	warnings: Array<string>
}

const DEFAULT_MAX_OPERATIONS = 300
const MAX_SMOKE_TESTS = 3

const IDENTITY_PATH_PATTERNS = [
	/^\/me(?:\/|$)/i,
	/^\/users?\/me(?:\/|$)/i,
	/^\/account(?:\/|$)/i,
	/^\/viewer(?:\/|$)/i,
]

function toOperationSummary(
	operation: OpenApiOperation,
): OpenApiOperationSummary {
	return {
		operationId: operation.operationId,
		slug: operation.slug,
		method: operation.method,
		path: operation.path,
		summary: operation.summary,
		tags: operation.tags,
		deprecated: operation.deprecated,
	}
}

function hostnameFromUrl(url: string): string | null {
	try {
		const parsed = new URL(url)
		return parsed.hostname || null
	} catch {
		return null
	}
}

function absoluteHttpsUrl(url: string): string | null {
	try {
		const parsed = new URL(url)
		if (parsed.protocol !== 'https:') return null
		return parsed.toString()
	} catch {
		return null
	}
}

function buildAuthDetail(scheme: OpenApiSecurityScheme): string {
	switch (scheme.type) {
		case 'http':
			return scheme.scheme ? `http ${scheme.scheme.toLowerCase()}` : 'http'
		case 'apiKey': {
			const location = scheme.in ?? 'unknown'
			const name = scheme.parameterName ?? 'unknown'
			return `apiKey in ${location} ${name}`
		}
		case 'oauth2':
			return scheme.flows.length > 0
				? `oauth2 ${scheme.flows.join(',')}`
				: 'oauth2'
		case 'openIdConnect':
			return 'openIdConnect'
		case 'mutualTLS':
			return 'mutualTLS'
		case 'unknown':
			return 'unknown'
		default: {
			const _exhaustive: never = scheme.type
			return _exhaustive
		}
	}
}

function buildKodyAuthPath(scheme: OpenApiSecurityScheme): string {
	switch (scheme.type) {
		case 'oauth2': {
			if (scheme.flows.includes('authorizationCode')) {
				return 'Save an integration via integration_save (authorization.authorizeUrl + tokenUrl), connect at /connect/oauth, then call APIs with createAuthenticatedFetch(kody, "<provider>").'
			}
			if (scheme.flows.includes('clientCredentials')) {
				return 'Store client id/secret as secrets and use the oauthClientCredentials execute helper to obtain tokens.'
			}
			return 'OAuth2 flow is not a first-class Kody integration path; store credentials as secrets and wire token exchange manually via execute fetch.'
		}
		case 'openIdConnect':
			return 'Save an integration via integration_save (authorization.authorizeUrl + tokenUrl), connect at /connect/oauth, then call APIs with createAuthenticatedFetch(kody, "<provider>").'
		case 'http': {
			const httpScheme = scheme.scheme?.toLowerCase() ?? ''
			if (httpScheme === 'bearer') {
				return 'Store a token secret and send Authorization: Bearer {{secret:<name>}} via execute fetch (gateway resolves placeholders and enforces the secret allowedHosts), or use a full integration + createAuthenticatedFetch when tokens rotate.'
			}
			if (httpScheme === 'basic') {
				return 'Use secretHeaders.basic({ usernameSecret, passwordSecret }) with execute fetch.'
			}
			return 'Store credentials as secrets and send the appropriate Authorization header via execute fetch with secret placeholders.'
		}
		case 'apiKey': {
			if (scheme.in === 'header') {
				const headerName = scheme.parameterName ?? '<header>'
				return `Store an API key secret and send it in the ${headerName} header via execute fetch using a {{secret:<name>}} placeholder (gateway enforces the secret allowedHosts).`
			}
			if (scheme.in === 'query' || scheme.in === 'cookie') {
				return `Store an API key secret and pass it via ${scheme.in} using a {{secret:<name>}} placeholder in execute fetch; caution: query-string credentials can leak into logs.`
			}
			return 'Store an API key secret and pass it via execute fetch using a {{secret:<name>}} placeholder; caution: query-string credentials can leak into logs.'
		}
		case 'mutualTLS':
			return 'mutualTLS is not directly supported by Kody; set up certificates manually outside the standard secret/integration helpers.'
		case 'unknown':
			return 'This security scheme type is not directly supported by Kody and needs manual setup.'
		default: {
			const _exhaustive: never = scheme.type
			return _exhaustive
		}
	}
}

function summarizeAuth(
	schemes: Array<OpenApiSecurityScheme>,
): Array<OpenApiAuthSuggestion> {
	return schemes.map((scheme) => ({
		schemeName: scheme.name,
		type: scheme.type,
		detail: buildAuthDetail(scheme),
		kodyAuthPath: buildKodyAuthPath(scheme),
	}))
}

function pathSegmentCount(path: string): number {
	return path.split('/').filter((segment) => segment.length > 0).length
}

function identityRank(path: string): number {
	const index = IDENTITY_PATH_PATTERNS.findIndex((pattern) =>
		pattern.test(path),
	)
	return index === -1 ? IDENTITY_PATH_PATTERNS.length : index
}

function isSmokeTestCandidate(operation: OpenApiOperation): boolean {
	if (operation.deprecated) return false
	if (operation.method !== 'get') return false
	if (operation.requestBody != null) return false
	const hasRequiredParam = operation.parameters.some(
		(parameter) => parameter.required,
	)
	return !hasRequiredParam
}

function selectSmokeTests(
	operations: Array<OpenApiOperation>,
): Array<OpenApiOperationSummary & { reason: string }> {
	const candidates = operations
		.filter(isSmokeTestCandidate)
		.map((operation, index) => ({
			operation,
			index,
			identity: identityRank(operation.path),
			segments: pathSegmentCount(operation.path),
		}))
		.sort((left, right) => {
			if (left.identity !== right.identity) {
				return left.identity - right.identity
			}
			if (left.segments !== right.segments) {
				return left.segments - right.segments
			}
			return left.index - right.index
		})
		.slice(0, MAX_SMOKE_TESTS)

	return candidates.map(({ operation, identity }) => {
		const identityHint =
			identity < IDENTITY_PATH_PATTERNS.length
				? 'likely identity endpoint'
				: 'simple read endpoint'
		return {
			...toOperationSummary(operation),
			reason: `GET with no required params; ${identityHint}`,
		}
	})
}

function matchesFilter(
	operation: OpenApiOperation,
	filter:
		| {
				tags?: Array<string>
				pathPrefixes?: Array<string>
				search?: string
		  }
		| undefined,
): boolean {
	if (filter == null) return true

	if (filter.tags != null && filter.tags.length > 0) {
		const wanted = new Set(filter.tags.map((tag) => tag.toLowerCase()))
		const hasTag = operation.tags.some((tag) => wanted.has(tag.toLowerCase()))
		if (!hasTag) return false
	}

	if (filter.pathPrefixes != null && filter.pathPrefixes.length > 0) {
		const matchesPrefix = filter.pathPrefixes.some((prefix) =>
			operation.path.startsWith(prefix),
		)
		if (!matchesPrefix) return false
	}

	if (filter.search != null && filter.search.trim().length > 0) {
		const needle = filter.search.toLowerCase()
		const haystack = [
			operation.path,
			operation.summary ?? '',
			operation.operationId ?? '',
			operation.slug,
		]
			.join('\n')
			.toLowerCase()
		if (!haystack.includes(needle)) return false
	}

	return true
}

export function summarizeOpenApiSpec(
	spec: ParsedOpenApiSpec,
	options?: {
		maxOperations?: number
		operationFilter?: {
			tags?: Array<string>
			pathPrefixes?: Array<string>
			search?: string
		}
	},
): OpenApiSpecSummary {
	const maxOperations = options?.maxOperations ?? DEFAULT_MAX_OPERATIONS
	const filtered = spec.operations.filter((operation) =>
		matchesFilter(operation, options?.operationFilter),
	)
	const truncated = filtered.length > maxOperations
	const operations = filtered.slice(0, maxOperations).map(toOperationSummary)

	const suggestedHosts: Array<string> = []
	let suggestedApiBaseUrl: string | null = null
	for (const server of spec.servers) {
		const httpsUrl = absoluteHttpsUrl(server.url)
		if (httpsUrl != null && suggestedApiBaseUrl == null) {
			suggestedApiBaseUrl = httpsUrl
		}
		const host = hostnameFromUrl(server.url)
		if (host != null && !suggestedHosts.includes(host)) {
			suggestedHosts.push(host)
		}
	}

	return {
		title: spec.title,
		version: spec.version,
		openapiVersion: spec.openapiVersion,
		servers: spec.servers,
		suggestedApiBaseUrl,
		suggestedHosts,
		auth: summarizeAuth(spec.securitySchemes),
		defaultSecuritySchemeNames: spec.defaultSecuritySchemeNames,
		suggestedSmokeTestOperations: selectSmokeTests(spec.operations),
		operations,
		operationCount: filtered.length,
		truncated,
		warnings: spec.warnings,
	}
}
