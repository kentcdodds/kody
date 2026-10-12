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
import { AsyncLocalStorage } from "node:async_hooks";
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

// Stamp ALS for statically imported package exports (same contract as cloud
// \`__kodyMeterStaticPackageExport\`). Nested published bundles keep one ambient
// \`fetch\` binding for the outer module path; the meter re-enters this ALS so
// gatewayFetch hops stamp the callee package, not the inlining consumer
// (kody#2876). Module-local ALS — do not hang the runner on Symbol.for.
const __kodySecretAuthorityAls = new AsyncLocalStorage();
const __kodyGetSecretAuthoritySymbol = Symbol.for("kody.getSecretAuthority");
const __kodyAsyncFunctionPrototype = Object.getPrototypeOf(async function () {});
function __kodyReadSecretAuthority() {
	const current = __kodySecretAuthorityAls.getStore();
	return typeof current === "string" && current.trim() ? current.trim() : null;
}
function __kodyRunWithSecretAuthority(packageId, callback) {
	return __kodySecretAuthorityAls.run(packageId, callback);
}
{
	const __globalAny = /** @type {any} */ (globalThis);
	const existing = Object.getOwnPropertyDescriptor(
		__globalAny,
		__kodyGetSecretAuthoritySymbol,
	);
	if (!existing || existing.configurable) {
		Object.defineProperty(__globalAny, __kodyGetSecretAuthoritySymbol, {
			value: __kodyReadSecretAuthority,
			writable: false,
			configurable: false,
			enumerable: false,
		});
	}
}
export function __kodyGetSecretAuthority() {
	return __kodyReadSecretAuthority();
}

// Pure placeholder builders — same shape as cloud execute helpers (including
// opaque refs from packageSecrets.get). Local isolate wraps globalThis.fetch
// with __kodyGatewayFetch so secret-bearing calls hop through CapabilityProxy
// (same as cloud), including frozen dependency copies that call
// globalThis.fetch instead of free \`fetch\`. Non-secret requests still use
// the captured native fetch (no 4 MiB hop).
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
const __kodyNativeFetch = globalThis.fetch.bind(globalThis);

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
 * cloud execute. Non-secret requests use the captured native fetch (no 4 MiB
 * hop cap, no CapabilityProxy round-trip).
 *
 * Prefer the meter ALS stamp (imported package export) over the module-path
 * closed-over id so nested inlined callees stamp as themselves (kody#2876).
 */
function __kodyResolveGatewayPackageId(fallbackPackageId) {
	// Prefer meter ALS over the module-path closed-over id so nested inlined
	// callees stamp as themselves (kody#2876). Prefer the module-local reader
	// when present (same evaluation as the meter); fall back to Symbol.for
	// for host readers. \`typeof\` on an undeclared binding is safe so
	// gateway-only unit-test slices still evaluate.
	let stamped = null;
	if (typeof __kodyReadSecretAuthority === "function") {
		const current = __kodyReadSecretAuthority();
		if (typeof current === "string" && current.trim()) {
			stamped = current.trim();
		}
	}
	if (!stamped) {
		const getter = globalThis[Symbol.for("kody.getSecretAuthority")];
		if (typeof getter === "function") {
			const current = getter();
			if (typeof current === "string" && current.trim()) {
				stamped = current.trim();
			}
		}
	}
	if (stamped) return stamped;
	const fallback =
		typeof fallbackPackageId === "string" ? fallbackPackageId.trim() : "";
	return fallback || null;
}

export function __kodyCreatePackageBoundGatewayFetch(packageId) {
	return async function gatewayFetch(input, init) {
		// Capture stamp synchronously before any await (same discipline as
		// cloud sandbox fetch): ALS must be read while the meter wrapper is
		// still active on this call stack.
		const authority = __kodyResolveGatewayPackageId(packageId);
		return __kodyGatewayFetchCall(input, init, authority);
	};
}

export async function __kodyGatewayFetch(input, init) {
	const authority = __kodyResolveGatewayPackageId(null);
	return __kodyGatewayFetchCall(input, init, authority);
}

function __kodyHasPlaceholderText(value) {
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
}

// Request.url percent-encodes braces in the path, and URLSearchParams encodes
// every placeholder character in the query, so decode before checking.
function __kodyRequestHasSecretPlaceholders(url, headers) {
	if (
		typeof url === "string" &&
		__kodyHasPlaceholderText(__kodyDecodePlaceholderPunctuation(url))
	) {
		return true;
	}
	for (const value of Object.values(headers ?? {})) {
		if (__kodyHasPlaceholderText(value)) return true;
	}
	return false;
}

function __kodyDecodePlaceholderPunctuation(text) {
	return text.replace(/%(7B|7D|3A|2F|3D|2C|7C)/gi, (_, hex) =>
		String.fromCharCode(Number.parseInt(hex, 16)),
	);
}

function __kodyIsVerbatimBodyMode(resolutionMode) {
	return resolutionMode === "off" || resolutionMode === "headers-only";
}

// The fetch gateway fills a placeholder in a text or multipart body, so a
// body that holds one hops through it. x-kody-secret-resolution: headers-only
// or off sends the body as written.
function __kodyBodyIsFillSite(headers, resolutionMode) {
	if (__kodyIsVerbatimBodyMode(resolutionMode)) return false;
	return true;
}

function __kodyIsMultipartType(contentType) {
	return (
		typeof contentType === "string" &&
		contentType.toLowerCase().startsWith("multipart/")
	);
}

// JSON CapabilityProxy hop cap (matches capabilityProxyAuthenticatedFetchMaxBodyBytes).
const __kodyGatewayFetchMaxBufferedBodyBytes = 4 * 1024 * 1024;

// A placeholder is short, so scanning overlapping windows finds one that
// straddles a chunk boundary without holding a large body as text.
const __kodyBodyScanOverlap = 8192;
const __kodyBodyScanChunkBytes = 64 * 1024;

function __kodyCreateBodyScanner() {
	let tail = "";
	return (bytes) => {
		const text = tail + __kodyBytesToAscii(bytes);
		tail = text.slice(-__kodyBodyScanOverlap);
		return __kodyHasPlaceholderText(__kodyDecodePlaceholderPunctuation(text));
	};
}

function __kodyBytesHoldPlaceholder(bytes) {
	const scan = __kodyCreateBodyScanner();
	for (
		let offset = 0;
		offset < bytes.byteLength;
		offset += __kodyBodyScanChunkBytes
	) {
		if (scan(bytes.subarray(offset, offset + __kodyBodyScanChunkBytes))) {
			return true;
		}
	}
	return false;
}

async function __kodyStreamHoldsPlaceholder(stream) {
	const reader = stream.getReader();
	const scan = __kodyCreateBodyScanner();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return false;
			if (scan(value instanceof Uint8Array ? value : new Uint8Array(value))) {
				return true;
			}
		}
	} finally {
		// A cloned body is a tee branch, and cancelling one branch settles only
		// after the other is cancelled too, so this must not be awaited.
		reader.cancel().catch(() => {});
	}
}

// Scans the caller's in-memory body where it is, so a large upload is not
// copied just to decide the hop.
async function __kodyBodyValueHoldsPlaceholder(body) {
	if (typeof body === "string") {
		return __kodyHasPlaceholderText(__kodyDecodePlaceholderPunctuation(body));
	}
	if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
		return __kodyHasPlaceholderText(
			__kodyDecodePlaceholderPunctuation(body.toString()),
		);
	}
	if (typeof Blob !== "undefined" && body instanceof Blob) {
		return await __kodyStreamHoldsPlaceholder(body.stream());
	}
	if (body instanceof ArrayBuffer) {
		return __kodyBytesHoldPlaceholder(new Uint8Array(body));
	}
	if (ArrayBuffer.isView(body)) {
		return __kodyBytesHoldPlaceholder(
			new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
		);
	}
	if (typeof FormData !== "undefined" && body instanceof FormData) {
		// FormData is multipart; hop when resolution is on so parts fill.
		return true;
	}
	return false;
}

async function __kodyGatewayFetchStreamCall(input) {
	if (typeof kody.gatewayFetchStream !== "function") {
		throw __kodyStreamingHostMissingError();
	}
	return kody.gatewayFetchStream(input);
}

function __kodyReadFetchSignal(input, init) {
	return init?.signal ?? (input instanceof Request ? input.signal : null);
}

function __kodyReadFetchRedirect(input, init) {
	return init?.redirect ?? (input instanceof Request ? input.redirect : null);
}

function __kodyNativeStreamInit({ method, headers, body, input, init }) {
	const next = { method, headers };
	if (body != null) {
		next.body = body;
		next.duplex = "half";
	}
	const signal = __kodyReadFetchSignal(input, init);
	if (signal != null) next.signal = signal;
	const redirect = __kodyReadFetchRedirect(input, init);
	if (redirect != null) next.redirect = redirect;
	return next;
}

function __kodyNativeRequestOverlay({ input, init }) {
	const next = {};
	const signal = __kodyReadFetchSignal(input, init);
	if (signal != null) next.signal = signal;
	const redirect = __kodyReadFetchRedirect(input, init);
	if (redirect != null) next.redirect = redirect;
	return Object.keys(next).length > 0 ? next : undefined;
}

function __kodyGatewayStreamControlFields({ input, init }) {
	const next = {};
	const signal = __kodyReadFetchSignal(input, init);
	if (signal != null) next.signal = signal;
	const redirect = __kodyReadFetchRedirect(input, init);
	if (redirect != null) next.redirect = redirect;
	return next;
}

function __kodyIsCallerByteStream(body) {
	return Boolean(
		body &&
			typeof body.getReader === "function" &&
			!(typeof Blob !== "undefined" && body instanceof Blob) &&
			!(typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) &&
			!(typeof FormData !== "undefined" && body instanceof FormData),
	);
}

// String, Blob, and bytes bodies inside a Request are byte streams. A caller
// ReadableStream is not, so BYOB acquisition fails. Probe before any read so
// the body stays usable.
function __kodyIsNonByteStream(body) {
	if (!body || typeof body.getReader !== "function") return false;
	let reader;
	try {
		reader = body.getReader({ mode: "byob" });
	} catch (error) {
		return error instanceof TypeError;
	}
	try {
		reader.releaseLock();
	} catch {
		// The body stays a byte stream either way.
	}
	return false;
}

function __kodyBytesToAscii(bytes) {
	return new TextDecoder("latin1").decode(bytes);
}

function __kodyStreamingHostMissingError() {
	return new Error(
		"Local execute needs kody.gatewayFetchStream on the host runtime to stream a secret-aware fetch body (multipart, large, or ReadableStream). Upgrade @kodycodes/cli, or buffer the body under 4 MiB for the JSON gatewayFetch hop.",
	);
}

const __kodySecretResolutionHeader = "x-kody-secret-resolution";

// init.headers replaces a Request's headers outright, matching new Request().
function __kodyReadSecretResolutionHeader(input, init) {
	if (init?.headers != null) {
		return new Headers(init.headers).get(__kodySecretResolutionHeader);
	}
	if (input instanceof Request) {
		return input.headers.get(__kodySecretResolutionHeader);
	}
	return null;
}

function __kodyWithoutSecretResolutionHeader(headers) {
	const stripped = new Headers(headers);
	stripped.delete(__kodySecretResolutionHeader);
	return stripped;
}

async function __kodyGatewayFetchCall(input, init, packageId) {
	// The resolution mode instructs the fetch gateway. It is never sent to the
	// remote on a native fetch, and only the gateway hop carries it.
	const resolutionHeader = __kodyReadSecretResolutionHeader(input, init);
	const resolutionMode = String(resolutionHeader ?? "")
		.trim()
		.toLowerCase();
	if (resolutionHeader != null && init?.headers != null) {
		init = {
			...init,
			headers: __kodyWithoutSecretResolutionHeader(init.headers),
		};
	}
	let url;
	let method = "GET";
	let headers = {};
	let bodyBytes = null;
	let streamingBody = null;
	// True when the stream hop is required to fill (known placeholders / multipart).
	let streamingBodyNeedsFill = false;
	// Prefer ambient fetch(input, init) when nothing consumed the original
	// body - that keeps implicit Content-Type from string /
	// URLSearchParams / Blob that a reconstructed Uint8Array body would drop.
	let reuseOriginal = true;
	let preservedRequest = null;
	if (typeof input === "string" || input instanceof URL) {
		url = String(input);
		method = String(init?.method ?? "GET");
		headers = Object.fromEntries(new Headers(init?.headers).entries());
		if (init?.body != null) {
			const body = init.body;
			if (__kodyIsCallerByteStream(body)) {
				// Streamed bodies hop through gatewayFetchStream when resolution
				// fills the body (or URL/headers), matching hosted streaming fill.
				reuseOriginal = false;
				if (__kodyIsVerbatimBodyMode(resolutionMode)) {
					return __kodyNativeFetch(
						url,
						__kodyNativeStreamInit({
							method,
							headers,
							body,
							input,
							init,
						}),
					);
				}
				streamingBody = body;
				// Caller streams are opaque; the gateway hop fills when needed.
				streamingBodyNeedsFill = true;
			} else if (
				typeof Blob !== "undefined" &&
				body instanceof Blob &&
				typeof body.stream === "function" &&
				!__kodyIsVerbatimBodyMode(resolutionMode) &&
				(__kodyRequestHasSecretPlaceholders(url, headers) ||
					(await __kodyBodyValueHoldsPlaceholder(body)) ||
					__kodyIsMultipartType(
						new Headers(headers).get("content-type") ?? body.type,
					))
			) {
				// Prefer Blob.stream() over arrayBuffer so large Blobs stay streamed.
				const encoded = new Request(url, { method, headers, body });
				method = encoded.method;
				headers = Object.fromEntries(encoded.headers.entries());
				streamingBody = body.stream();
				streamingBodyNeedsFill = true;
				reuseOriginal = false;
			} else if (
				__kodyRequestHasSecretPlaceholders(url, headers) ||
				(__kodyBodyIsFillSite(headers, resolutionMode) &&
					(await __kodyBodyValueHoldsPlaceholder(body)))
			) {
				// The hop copy carries the implicit Content-Type (and multipart
				// boundary) of a string, URLSearchParams, or FormData body.
				// Keep the pre-Request url string so path {{secret:…}}
				// placeholders are not percent-encoded by Request.
				const encoded = new Request(url, { method, headers, body });
				method = encoded.method;
				headers = Object.fromEntries(encoded.headers.entries());
				bodyBytes = new Uint8Array(await encoded.arrayBuffer());
				reuseOriginal = false;
			}
		}
	} else {
		// Probe the caller's body before copying it into a new Request. That
		// copy drops BYOB, so a string body would look like a caller stream.
		const inputRequest = input instanceof Request ? input : null;
		const requestStream =
			(init == null || init.body == null) &&
			inputRequest != null &&
			__kodyIsNonByteStream(inputRequest.body);
		let merged = new Request(input, init);
		if (merged.headers.has(__kodySecretResolutionHeader)) {
			merged = new Request(merged, {
				headers: __kodyWithoutSecretResolutionHeader(merged.headers),
			});
			// The caller's Request still carries the header, so only the
			// stripped copy may be forwarded.
			reuseOriginal = false;
		}
		url = merged.url;
		method = merged.method;
		headers = Object.fromEntries(merged.headers.entries());
		if (method !== "GET" && method !== "HEAD" && merged.body) {
			if (__kodyIsCallerByteStream(init?.body) || requestStream) {
				if (__kodyIsVerbatimBodyMode(resolutionMode)) {
					return __kodyNativeFetch(
						merged,
						__kodyNativeRequestOverlay({ input, init }),
					);
				}
				streamingBody = merged.body;
				streamingBodyNeedsFill = true;
				reuseOriginal = false;
			} else {
				// String, bytes, and URLSearchParams become streams inside a
				// Request. A clone is scanned chunk by chunk to decide the hop,
				// and only a hop buffers the body. Otherwise the original Request
				// is forwarded so cache, credentials, and redirect replay stay
				// intact. Caller ReadableStream bodies are handled above.
				if (
					__kodyRequestHasSecretPlaceholders(url, headers) ||
					(__kodyBodyIsFillSite(headers, resolutionMode) &&
						(await __kodyStreamHoldsPlaceholder(merged.clone().body)))
				) {
					bodyBytes = new Uint8Array(await merged.clone().arrayBuffer());
				}
				reuseOriginal = false;
				preservedRequest = merged;
			}
		} else {
			preservedRequest = merged;
		}
	}
	const hopHeaders =
		resolutionHeader != null
			? { ...headers, [__kodySecretResolutionHeader]: resolutionHeader }
			: headers;
	if (streamingBody != null && !__kodyIsVerbatimBodyMode(resolutionMode)) {
		if (typeof kody.gatewayFetchStream === "function") {
			return __kodyGatewayFetchStreamCall({
				...(packageId ? { packageId } : {}),
				request: {
					url,
					method,
					headers: hopHeaders,
					body: streamingBody,
					...__kodyGatewayStreamControlFields({ input, init }),
				},
			});
		}
		// Older CLI: never forward a body that needs fill unfilled. Buffer to
		// classify — JSON hop under 4 MiB, otherwise require gatewayFetchStream.
		if (
			streamingBodyNeedsFill ||
			__kodyRequestHasSecretPlaceholders(url, headers)
		) {
			const buffered = new Uint8Array(
				await new Response(streamingBody).arrayBuffer(),
			);
			if (
				__kodyRequestHasSecretPlaceholders(url, headers) ||
				__kodyBytesHoldPlaceholder(buffered) ||
				__kodyIsMultipartType(headers["content-type"])
			) {
				if (buffered.byteLength > __kodyGatewayFetchMaxBufferedBodyBytes) {
					throw __kodyStreamingHostMissingError();
				}
				bodyBytes = buffered;
				streamingBody = null;
			} else {
				return __kodyNativeFetch(
					url,
					__kodyNativeStreamInit({
						method,
						headers,
						body: buffered,
						input,
						init,
					}),
				);
			}
		} else {
			return __kodyNativeFetch(
				url,
				__kodyNativeStreamInit({
					method,
					headers,
					body: streamingBody,
					input,
					init,
				}),
			);
		}
	}
	if (bodyBytes == null && !__kodyRequestHasSecretPlaceholders(url, headers)) {
		if (reuseOriginal) {
			return __kodyNativeFetch(input, init);
		}
		if (preservedRequest) {
			return __kodyNativeFetch(
				preservedRequest,
				__kodyNativeRequestOverlay({ input, init }),
			);
		}
		return __kodyNativeFetch(
			url,
			__kodyNativeStreamInit({
				method,
				headers,
				body: undefined,
				input,
				init,
			}),
		);
	}
	// Large buffered bodies use the streaming hop (no 4 MiB JSON cap).
	if (
		bodyBytes != null &&
		bodyBytes.byteLength > __kodyGatewayFetchMaxBufferedBodyBytes
	) {
		return __kodyGatewayFetchStreamCall({
			...(packageId ? { packageId } : {}),
			request: {
				url,
				method,
				headers: hopHeaders,
				body: bodyBytes,
				...__kodyGatewayStreamControlFields({ input, init }),
			},
		});
	}
	// Multipart always uses the streaming hop so part placeholders fill the
	// same way as hosted (and so we never base64 a multipart body).
	if (bodyBytes != null && __kodyIsMultipartType(headers["content-type"])) {
		return __kodyGatewayFetchStreamCall({
			...(packageId ? { packageId } : {}),
			request: {
				url,
				method,
				headers: hopHeaders,
				body: bodyBytes,
				...__kodyGatewayStreamControlFields({ input, init }),
			},
		});
	}
	const result = await kody.gatewayFetch({
		...(packageId ? { packageId } : {}),
		request: {
			url,
			method,
			headers: hopHeaders,
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

const __kodyLocalExecuteFetchPatchedSymbol = Symbol.for(
	"kody.localExecuteFetchPatched",
);
if (!globalThis[__kodyLocalExecuteFetchPatchedSymbol]) {
	globalThis.fetch = (input, init) => __kodyGatewayFetch(input, init);
	globalThis[__kodyLocalExecuteFetchPatchedSymbol] = true;
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

// Artifacts published before the shared runtime was externalized inline a
// full cloud runtime copy, and later consumers compose them verbatim, so that
// copy survives with no \`// virtual:\` banner for the rewrite to strip. It
// resolves stamped packageStorage / packageSecrets through the shared runtime
// ALS store (\`__kodyPackageStorage(packageId)\`), as hosted runs do. The CLI
// host enters that ALS with its own runtime object, so expose a view of the
// store that adds the CapabilityProxy-backed factories.
const __kodyRuntimeStorageSymbol = Symbol.for("kody.runtimeStorage");
const __kodyLocalRuntimeStorageViewSymbol = Symbol.for(
	"kody.localExecuteRuntimeStorageView",
);
{
	const __globalAny = /** @type {any} */ (globalThis);
	const hostStorage =
		__globalAny[__kodyRuntimeStorageSymbol] ?? new AsyncLocalStorage();
	if (!hostStorage[__kodyLocalRuntimeStorageViewSymbol]) {
		const views = new WeakMap();
		const viewOf = (store) => {
			if (store == null || typeof store !== "object") return store;
			let view = views.get(store);
			if (!view) {
				view = Object.freeze({
					...store,
					__kodyPackageStorage:
						store.__kodyPackageStorage ??
						((packageId) => __kodyCreatePackageBoundStorage(packageId)()),
					__kodyPackageSecrets:
						store.__kodyPackageSecrets ??
						((packageId) => __kodyCreatePackageBoundSecrets(packageId)),
				});
				views.set(store, view);
			}
			return view;
		};
		__globalAny[__kodyRuntimeStorageSymbol] = Object.freeze({
			[__kodyLocalRuntimeStorageViewSymbol]: true,
			getStore: () => viewOf(hostStorage.getStore()),
			run: (store, callback, ...args) =>
				hostStorage.run(store, callback, ...args),
		});
	}
}

/**
 * Local counterpart of cloud \`__kodyMeterStaticPackageExport\`: wrap function
 * exports so their bodies run under the callee package stamp ALS. Usage
 * metering stays cloud-only; this wrapper exists so nested inlined packages
 * stamp gatewayFetch / secret authority as the imported package (kody#2876).
 */
export function __kodyMeterStaticPackageExport(packageId, exportValue) {
	if (typeof exportValue !== "function") return exportValue;
	const stampedId =
		typeof packageId === "string" && packageId.trim() ? packageId.trim() : "";
	if (!stampedId) return exportValue;
	return new Proxy(exportValue, {
		construct(target, argumentsList, newTarget) {
			return __kodyRunWithSecretAuthority(stampedId, () =>
				Reflect.construct(target, argumentsList, newTarget),
			);
		},
		apply(target, thisArg, argumentsList) {
			// Async callees must be awaited inside ALS.run so the stamp
			// survives awaits in the callee body (workerd loses ALS when the
			// sync run() callback only *returns* a Promise). Key off the
			// intrinsic AsyncFunction prototype — never target.constructor.
			if (Object.getPrototypeOf(target) === __kodyAsyncFunctionPrototype) {
				return __kodyRunWithSecretAuthority(stampedId, async () =>
					await Reflect.apply(target, thisArg, argumentsList),
				);
			}
			return __kodyRunWithSecretAuthority(stampedId, () =>
				Reflect.apply(target, thisArg, argumentsList),
			);
		},
	});
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
