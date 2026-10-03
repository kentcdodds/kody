/**
 * Local-execute runtime shim source builders and inlined-CAF rewrite.
 *
 * Loaded on the Worker through the pre-bundled additional module
 * `node_modules/.kody-generated/local-execute-runtime-support.mjs` so the
 * platform/runtime startup entries do not carry these templates or the
 * rewrite AST walk (kody#2831). Node tests import this TypeScript module
 * directly (or via the vitest alias of that generated specifier).
 */

import {
	createRelativeImportSpecifier,
	normalizeWorkspaceModulePath,
	runtimeModulePath,
} from './module-graph-path-basics.ts'

export {
	moduleSourceHasInlinedKodyRuntime,
	rewriteInlinedLocalExecuteBundleSource,
} from './rewrite-inlined-local-runtime.ts'

/** Host module name the CLI registers in local workerd (`localWorkerModuleNames.runtime`). */
export const localExecuteHostRuntimeModuleName = 'kody:runtime'

/**
 * Local workerd supplies `kody:runtime` (CapabilityProxy bridge). Stamped
 * package modules still import `.__kody_virtual__/runtime.js` / package-runtime
 * facades; this shim re-exports the host runtime and binds stamped
 * packageStorage / packageSecrets / createAuthenticatedFetch through
 * CapabilityProxy hops so long-lived OAuth tokens never enter local workerd
 * (kody#2810).
 *
 * `modulePath` must be the workerd module name this source is registered under.
 * The host import uses a relative specifier so workerd resolves it to the
 * exact `kody:runtime` module name — bare `"kody:runtime"` from a path-like
 * module (`.__kody_virtual__/runtime.js` or a nested published-bundle copy)
 * path-joins to `…/.__kody_virtual__/kody:runtime` and fails.
 */
export function createLocalExecuteRuntimeShimSource(
	modulePath: string = runtimeModulePath,
) {
	const hostRuntimeSpecifier = createRelativeImportSpecifier(
		normalizeWorkspaceModulePath(modulePath),
		localExecuteHostRuntimeModuleName,
	)
	return `
import {
	kody,
	packageContext,
	email,
	workflows,
	packages,
	events,
	default as __kodyHostRuntimeDefault,
} from ${JSON.stringify(hostRuntimeSpecifier)};

export {
	kody,
	packageContext,
	email,
	workflows,
	packages,
	events,
};

// Pure placeholder builders — same shape as cloud execute helpers (including
// opaque refs from packageSecrets.get). Local ambient fetch does not expand
// them; package-graph rebinds fetch to __kodyGatewayFetch so secret-bearing
// calls hop through CapabilityProxy to the fetch gateway (same as cloud).
export function __kodySecretRef(name, scope) {
	const trimmed = String(name ?? "").trim();
	if (!trimmed) {
		throw new Error("__kodySecretRef requires a non-empty secret name.");
	}
	if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
		throw new Error(
			"__kodySecretRef name must use letters, numbers, dots, underscores, or hyphens.",
		);
	}
	if (scope == null) {
		return "{{" + "secret:" + trimmed + "}}";
	}
	if (scope === "package" || scope === "session" || scope === "user") {
		return "{{" + "secret:" + trimmed + "|scope=" + scope + "}}";
	}
	throw new Error(\`Unsupported secret scope "\${scope}".\`);
}

const __kodyParseSecretNameOrPlaceholder = (value, fieldName) => {
	const trimmed = String(value ?? "").trim();
	if (!trimmed) {
		throw new Error(\`secretHeaders.basic requires \${fieldName}.\`);
	}
	if (trimmed.startsWith("{{") && trimmed.endsWith("}}")) {
		const match =
			/^\\{\\{secret:([a-zA-Z0-9._-]+)(?:\\|scope=(session|package|user))?\\}}$/.exec(
				trimmed,
			);
		if (!match) {
			throw new Error(
				\`\${fieldName} must be a saved secret name or a single {{secret:…}} opaque ref.\`,
			);
		}
		const scope = match[2];
		return {
			name: match[1],
			scope:
				scope === "package" || scope === "session" || scope === "user"
					? scope
					: null,
		};
	}
	if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
		throw new Error(
			\`\${fieldName} must be a saved secret name using letters, numbers, dots, underscores, or hyphens, or a single {{secret:…}} opaque ref.\`,
		);
	}
	return { name: trimmed, scope: null };
};
const __kodyNormalizeOptionalSecretScope = (scope) => {
	if (scope == null) return null;
	if (scope === "package" || scope === "session" || scope === "user") return scope;
	throw new Error(\`Unsupported secret scope "\${scope}".\`);
};
const __kodyResolveBasicAuthSecretScope = (input) => {
	const explicit = __kodyNormalizeOptionalSecretScope(input.explicitScope);
	if (explicit != null) return explicit;
	const usernameScope = input.usernameScope;
	const passwordScope = input.passwordScope;
	if (usernameScope == null) return passwordScope;
	if (passwordScope == null) return usernameScope;
	if (usernameScope !== passwordScope) {
		throw new Error(
			"usernameSecret and passwordSecret opaque refs disagree on scope. Pass scope explicitly or use matching refs.",
		);
	}
	return usernameScope;
};
export const secretHeaders = {
	basic(input) {
		const username = __kodyParseSecretNameOrPlaceholder(
			input?.usernameSecret,
			"usernameSecret",
		);
		const password = __kodyParseSecretNameOrPlaceholder(
			input?.passwordSecret,
			"passwordSecret",
		);
		const scope = __kodyResolveBasicAuthSecretScope({
			explicitScope: input?.scope,
			usernameScope: username.scope,
			passwordScope: password.scope,
		});
		return scope
			? \`{{secret-basic:username=\${username.name},password=\${password.name}|scope=\${scope}}}\`
			: \`{{secret-basic:username=\${username.name},password=\${password.name}}}\`;
	},
};

// Client-credentials grants need host-side secret expansion — hop through
// CapabilityProxy so long-lived secret values never enter local workerd.
export async function oauthClientCredentials(input) {
	return await kody.oauthClientCredentials(input ?? {});
}

export function __kodyCreatePackageBoundOauthClientCredentials(packageId) {
	return async function oauthClientCredentials(input) {
		return await kody.oauthClientCredentials({
			...(input ?? {}),
			packageId,
		});
	};
}

const __kodyNullBodyStatuses = new Set([204, 205, 304]);

function __kodyBytesToBase64(bytes) {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 1) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

function __kodyBase64ToBytes(value) {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

async function __kodyBodyToBytes(body) {
	if (typeof body === "string") {
		return new TextEncoder().encode(body);
	}
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body)) {
		return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	}
	if (typeof Blob !== "undefined" && body instanceof Blob) {
		return new Uint8Array(await body.arrayBuffer());
	}
	if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
		return new TextEncoder().encode(body.toString());
	}
	if (body && typeof body.getReader === "function") {
		return new Uint8Array(await new Response(body).arrayBuffer());
	}
	if (typeof FormData !== "undefined" && body instanceof FormData) {
		throw new Error(
			"Local execute createAuthenticatedFetch does not support FormData bodies yet; use Uint8Array, Blob, or string.",
		);
	}
	throw new Error(
		"Local execute createAuthenticatedFetch could not serialize the request body.",
	);
}

export function __kodyCreatePackageBoundAuthenticatedFetch(packageId) {
	return async function createAuthenticatedFetch(providerName) {
		return __kodyCreateAuthenticatedFetch(providerName, packageId);
	};
}

export async function createAuthenticatedFetch(providerName) {
	return __kodyCreateAuthenticatedFetch(providerName, null);
}

async function __kodyCreateAuthenticatedFetch(providerName, packageId) {
	const name = String(providerName ?? "").trim();
	if (!name) {
		throw new Error("Integration name is required.");
	}
	return async (input, init) => {
		let url;
		let method = "GET";
		let headers = {};
		let bodyBytes = null;
		if (typeof input === "string" || input instanceof URL) {
			url = String(input);
			method = String(init?.method ?? "GET");
			headers = Object.fromEntries(new Headers(init?.headers).entries());
			if (init?.body != null) {
				bodyBytes = await __kodyBodyToBytes(init.body);
			}
		} else {
			// Match cloud createAuthenticatedFetch: new Request(input, init) so
			// init overrides method/headers/body when input is already a Request.
			const merged = new Request(input, init);
			url = merged.url;
			method = merged.method;
			headers = Object.fromEntries(merged.headers.entries());
			if (method !== "GET" && method !== "HEAD") {
				bodyBytes = new Uint8Array(await merged.arrayBuffer());
			}
		}
		const result = await kody.authenticatedFetch({
			providerName: name,
			...(packageId ? { packageId } : {}),
			request: {
				url,
				method,
				headers,
				...(bodyBytes != null
					? { bodyBase64: __kodyBytesToBase64(bodyBytes) }
					: {}),
			},
		});
		const bytes = __kodyBase64ToBytes(result.bodyBase64 ?? "");
		return new Response(
			__kodyNullBodyStatuses.has(result.status) ? null : bytes,
			{
				status: result.status,
				statusText: result.statusText,
				headers: result.headers,
			},
		);
	};
}

/**
 * Secret-aware ambient fetch for local execute: hops through CapabilityProxy
 * \`kody.gatewayFetch\` when the request carries secret / integration-token
 * placeholders so expansion happens on origin via the same fetch gateway as
 * cloud execute. Non-secret requests use ambient global fetch (no 4 MiB hop
 * cap, no CapabilityProxy round-trip).
 */
export function __kodyCreatePackageBoundGatewayFetch(packageId) {
	return async function gatewayFetch(input, init) {
		return __kodyGatewayFetchCall(input, init, packageId);
	};
}

export async function __kodyGatewayFetch(input, init) {
	return __kodyGatewayFetchCall(input, init, null);
}

function __kodyRequestHasSecretPlaceholders(url, headers, bodyText) {
	const probe = (value) => {
		if (typeof value !== "string" || !value.includes("{{")) return false;
		return (
			// Escape the scope pipe (| in generated source): bare | is regex
			// alternation and would miss {{secret:name|scope=user}} from
			// __kodySecretRef.
			/{{secret:[a-zA-Z0-9._-]+(?:\\|scope=(?:session|package|user))?}}/.test(
				value,
			) ||
			/{{secret-basic:[^}]+}}/.test(value) ||
			/{{integration-token:[a-zA-Z0-9._-]+}}/.test(value) ||
			/{{secret\\/[a-zA-Z0-9._-]+:[^}]+}}/.test(value)
		);
	};
	if (probe(url)) return true;
	if (probe(bodyText)) return true;
	for (const value of Object.values(headers ?? {})) {
		if (probe(value)) return true;
	}
	return false;
}

async function __kodyGatewayFetchCall(input, init, packageId) {
	let url;
	let method = "GET";
	let headers = {};
	let bodyBytes = null;
	if (typeof input === "string" || input instanceof URL) {
		url = String(input);
		method = String(init?.method ?? "GET");
		headers = Object.fromEntries(new Headers(init?.headers).entries());
		if (init?.body != null) {
			bodyBytes = await __kodyBodyToBytes(init.body);
		}
	} else {
		const merged = new Request(input, init);
		url = merged.url;
		method = merged.method;
		headers = Object.fromEntries(merged.headers.entries());
		if (method !== "GET" && method !== "HEAD") {
			bodyBytes = new Uint8Array(await merged.arrayBuffer());
		}
	}
	const bodyText =
		bodyBytes != null ? new TextDecoder().decode(bodyBytes) : null;
	if (!__kodyRequestHasSecretPlaceholders(url, headers, bodyText)) {
		// Probe may have already consumed Request/stream bodies — never reuse
		// the original input/init when we hold body bytes.
		if (bodyBytes == null) {
			return globalThis.fetch(input, init);
		}
		const fallbackInit = {
			method,
			headers,
			body: bodyBytes,
		};
		const signal =
			init?.signal ?? (input instanceof Request ? input.signal : null);
		if (signal != null) fallbackInit.signal = signal;
		const redirect =
			init?.redirect ?? (input instanceof Request ? input.redirect : null);
		if (redirect != null) fallbackInit.redirect = redirect;
		return globalThis.fetch(url, fallbackInit);
	}
	const result = await kody.gatewayFetch({
		...(packageId ? { packageId } : {}),
		request: {
			url,
			method,
			headers,
			...(bodyBytes != null
				? { bodyBase64: __kodyBytesToBase64(bodyBytes) }
				: {}),
		},
	});
	const bytes = __kodyBase64ToBytes(result.bodyBase64 ?? "");
	return new Response(
		__kodyNullBodyStatuses.has(result.status) ? null : bytes,
		{
			status: result.status,
			statusText: result.statusText,
			headers: result.headers,
		},
	);
}

export function __kodyCreatePackageBoundStorage(packageId) {
	return function packageStorage() {
		return {
			id: "package:" + encodeURIComponent(packageId),
			get: async (key) =>
				(await kody.packageStorageGet({ packageId, key })).value,
			list: async (options = {}) =>
				await kody.packageStorageList({ ...options, packageId }),
			sql: async (query, params = []) =>
				await kody.packageStorageSql({
					packageId,
					query,
					params,
					writable: true,
				}),
			set: async (key, value) =>
				await kody.packageStorageSet({ packageId, key, value }),
			delete: async (key) =>
				await kody.packageStorageDelete({ packageId, key }),
			clear: async () => await kody.packageStorageClear({ packageId }),
		};
	};
}

export function __kodyCreatePackageBoundSecrets(packageId) {
	return {
		get: async (alias) => {
			const normalizedAlias = typeof alias === "string" ? alias.trim() : "";
			if (!normalizedAlias) {
				throw new Error("packageSecrets.get requires a non-empty alias.");
			}
			const result = await kody.packageSecretGet({
				alias: normalizedAlias,
				__kodySecretAuthorityPackageId: packageId,
			});
			return typeof result?.value === "string" ? result.value : "";
		},
		has: async (alias) => {
			const normalizedAlias = typeof alias === "string" ? alias.trim() : "";
			if (!normalizedAlias) {
				throw new Error("packageSecrets.has requires a non-empty alias.");
			}
			const result = await kody.packageSecretHas({
				alias: normalizedAlias,
				__kodySecretAuthorityPackageId: packageId,
			});
			return result?.has === true;
		},
	};
}

export function __kodyMeterStaticPackageExport(_packageId, exportValue) {
	return exportValue;
}

export function packageStorage() {
	throw new Error(
		"packageStorage() requires package provenance: this module was not bundled from a saved package and the run has no package context. " +
			"Ad hoc execute has no scratch SQLite helper. Persist durable state from a saved package with packageStorage().",
	);
}

function __kodyPackageSecretsUnavailable() {
	throw new Error(
		"packageSecrets is not available in this execution context. It is bound for stamped saved-package modules and saved-package runtime contexts.",
	);
}

export const packageSecrets = {
	get: async () => __kodyPackageSecretsUnavailable(),
	has: async () => __kodyPackageSecretsUnavailable(),
};

const __kodyLocalRuntimeDefault = Object.freeze({
	...(__kodyHostRuntimeDefault && typeof __kodyHostRuntimeDefault === "object"
		? __kodyHostRuntimeDefault
		: {}),
	kody,
	packageStorage,
	createAuthenticatedFetch,
	secretHeaders,
	oauthClientCredentials,
	packageContext,
	packageSecrets,
	email,
	workflows,
	packages,
	events,
});
export default __kodyLocalRuntimeDefault;
export const KodyRuntime = Object.freeze({
	defaultValue: __kodyLocalRuntimeDefault,
});
`.trim()
}

/**
 * Per-package virtual runtime for local execute: same surface as cloud's
 * createPackageRuntimeModuleSource, but createAuthenticatedFetch closes over
 * the stamped package id so CapabilityProxy / fetch-gateway integration
 * approvals see package identity.
 */
export function createLocalExecutePackageRuntimeModuleSource(
	packageId: string,
) {
	const baseRuntimeSpecifier = '../runtime.js'
	return `
export { kody, secretHeaders, packageContext, email, workflows, packages, events } from ${JSON.stringify(
		baseRuntimeSpecifier,
	)};
import __kodyBaseRuntimeDefault, {
	__kodyCreatePackageBoundStorage,
	__kodyCreatePackageBoundSecrets,
	__kodyCreatePackageBoundAuthenticatedFetch,
	__kodyCreatePackageBoundOauthClientCredentials,
} from ${JSON.stringify(baseRuntimeSpecifier)};
export const packageStorage = __kodyCreatePackageBoundStorage(${JSON.stringify(
		packageId,
	)});
export const packageSecrets = __kodyCreatePackageBoundSecrets(${JSON.stringify(
		packageId,
	)});
export const createAuthenticatedFetch = __kodyCreatePackageBoundAuthenticatedFetch(${JSON.stringify(
		packageId,
	)});
export const oauthClientCredentials = __kodyCreatePackageBoundOauthClientCredentials(${JSON.stringify(
		packageId,
	)});
// Local base runtime default is Object.freeze'd. Proxying that frozen target
// while returning different packageStorage / packageSecrets /
// createAuthenticatedFetch / oauthClientCredentials values violates Proxy
// invariants and throws on default-export property access. Clone with the
// bound overrides first.
const __kodyPackageRuntimeDefault = new Proxy(
	Object.freeze({
		...__kodyBaseRuntimeDefault,
		packageStorage,
		packageSecrets,
		createAuthenticatedFetch,
		oauthClientCredentials,
	}),
	{
		get(target, property, receiver) {
			if (property === "packageStorage") return packageStorage;
			if (property === "packageSecrets") return packageSecrets;
			if (property === "createAuthenticatedFetch") return createAuthenticatedFetch;
			if (property === "oauthClientCredentials") return oauthClientCredentials;
			return Reflect.get(target, property, receiver);
		},
		has(target, property) {
			return (
				property === "packageStorage" ||
				property === "packageSecrets" ||
				property === "createAuthenticatedFetch" ||
				property === "oauthClientCredentials" ||
				Reflect.has(target, property)
			);
		},
	},
);
export default __kodyPackageRuntimeDefault;
export const KodyRuntime = Object.freeze({ defaultValue: __kodyPackageRuntimeDefault });
`.trim()
}
