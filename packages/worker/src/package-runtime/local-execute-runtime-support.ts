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

const __kodyStreamingPlaceholderLimit = 4096;

function __kodyIsCallerByteStream(body) {
	return Boolean(
		body &&
			typeof body.getReader === "function" &&
			!(typeof Blob !== "undefined" && body instanceof Blob) &&
			!(typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) &&
			!(typeof FormData !== "undefined" && body instanceof FormData),
	);
}

function __kodyConcatBytes(chunks) {
	let length = 0;
	for (const chunk of chunks) length += chunk.byteLength;
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function __kodyBytesToAscii(bytes) {
	return new TextDecoder("latin1").decode(bytes);
}

function __kodyStreamingSecretError() {
	return new Error(
		"Local execute secret-aware fetch cannot expand secret placeholders in a streaming body. Buffer the body or remove {{secret:…}} placeholders.",
	);
}

function __kodyStreamingWindowError() {
	return new Error(
		"Local execute secret-aware fetch cannot check a streaming body for secret placeholders past the inspection window. Buffer the body or remove {{secret:…}} placeholders.",
	);
}

function __kodyStreamingHeaderError() {
	return new Error(
		"Local execute secret-aware fetch cannot use a streaming body when the URL or headers contain secret placeholders. Buffer the body, or remove those placeholders.",
	);
}

function __kodyUnclosedCouldBeSecret(tail) {
	if (!tail.includes("{{")) return false;
	const starters = [
		"{{secret:",
		"{{secret-basic:",
		"{{integration-token:",
		"{{secret/",
	];
	for (const starter of starters) {
		const length = Math.min(starter.length, tail.length);
		if (starter.slice(0, length) === tail.slice(0, length)) return true;
		if (tail.startsWith(starter)) return true;
	}
	return false;
}

function __kodyStreamingDecision(text) {
	if (__kodyRequestHasSecretPlaceholders("", {}, text)) {
		return { reject: "secret", hold: 0 };
	}
	const lastClose = text.lastIndexOf("}}");
	const rest = lastClose === -1 ? text : text.slice(lastClose + 2);
	const open = rest.lastIndexOf("{{");
	if (open === -1) {
		return { reject: null, hold: rest.endsWith("{") ? 1 : 0 };
	}
	const tail = rest.slice(open);
	if (tail.includes("}}") || !__kodyUnclosedCouldBeSecret(tail)) {
		return { reject: null, hold: rest.endsWith("{") ? 1 : 0 };
	}
	if (tail.length > __kodyStreamingPlaceholderLimit) {
		return { reject: "window", hold: 0 };
	}
	return { reject: null, hold: tail.length };
}

function __kodyScanStreamingBody(source) {
	const reader = source.getReader();
	let carry = new Uint8Array(0);
	return new ReadableStream({
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) {
				if (carry.byteLength > 0) {
					const text = __kodyBytesToAscii(carry);
					if (__kodyEofHasUnresolvedSecret(text)) {
						controller.error(__kodyStreamingSecretError());
						return;
					}
					controller.enqueue(carry);
					carry = new Uint8Array(0);
				}
				controller.close();
				return;
			}
			const chunk =
				value instanceof Uint8Array ? value : new Uint8Array(value);
			const data = __kodyConcatBytes([carry, chunk]);
			carry = new Uint8Array(0);
			const decision = __kodyStreamingDecision(__kodyBytesToAscii(data));
			if (decision.reject === "secret") {
				controller.error(__kodyStreamingSecretError());
				try {
					await reader.cancel();
				} catch {
					// The caller already has the failure.
				}
				return;
			}
			if (decision.reject === "window") {
				controller.error(__kodyStreamingWindowError());
				try {
					await reader.cancel();
				} catch {
					// The caller already has the failure.
				}
				return;
			}
			const emitLength = data.byteLength - decision.hold;
			if (emitLength > 0) {
				controller.enqueue(data.subarray(0, emitLength));
			}
			if (decision.hold > 0) {
				carry = data.subarray(data.byteLength - decision.hold);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}

function __kodyEofHasUnresolvedSecret(text) {
	if (__kodyRequestHasSecretPlaceholders("", {}, text)) return true;
	const lastClose = text.lastIndexOf("}}");
	const rest = lastClose === -1 ? text : text.slice(lastClose + 2);
	const open = rest.lastIndexOf("{{");
	if (open === -1) return false;
	const tail = rest.slice(open);
	// "{{" by itself is not a placeholder. A longer unclosed prefix of
	// {{secret:…}} or {{integration-token:…}} still fails closed.
	if (tail.length <= 2) return false;
	return __kodyUnclosedCouldBeSecret(tail);
}

async function __kodyBlobHasSecretPlaceholder(blob) {
	const reader = blob.stream().getReader();
	let carry = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) return __kodyEofHasUnresolvedSecret(carry);
		const chunk =
			value instanceof Uint8Array ? value : new Uint8Array(value);
		const text = carry + __kodyBytesToAscii(chunk);
		if (__kodyRequestHasSecretPlaceholders("", {}, text)) return true;
		const decision = __kodyStreamingDecision(text);
		if (decision.reject === "window") {
			throw __kodyStreamingWindowError();
		}
		carry =
			decision.hold > 0 ? text.slice(text.length - decision.hold) : "";
	}
}

async function __kodyGatewayFetchCall(input, init, packageId) {
	let url;
	let method = "GET";
	let headers = {};
	let bodyBytes = null;
	let streamingBody = null;
	// Prefer ambient fetch(input, init) when the probe did not consume the
	// original body - that keeps implicit Content-Type from string /
	// URLSearchParams / Blob that a reconstructed Uint8Array body would drop.
	let reuseOriginal = true;
	let preservedRequest = null;
	if (typeof input === "string" || input instanceof URL) {
		url = String(input);
		method = String(init?.method ?? "GET");
		headers = Object.fromEntries(new Headers(init?.headers).entries());
		if (init?.body != null) {
			const body = init.body;
			// FormData cannot be byte-probed / gateway-serialized. Detect
			// placeholders in field strings; otherwise reuse ambient fetch so
			// non-secret multipart POSTs keep working under --local.
			if (typeof FormData !== "undefined" && body instanceof FormData) {
				let formText = "";
				for (const [name, value] of body.entries()) {
					formText += name + "\\n";
					if (typeof value === "string") {
						formText += value + "\\n";
					} else if (value && typeof value.name === "string") {
						formText += value.name + "\\n";
					}
				}
				// Secrets inside multipart field names/values cannot be expanded
				// by the fetch gateway (body is opaque). Header/URL secrets with
				// a clean FormData body still hop like cloud.
				if (
					__kodyRequestHasSecretPlaceholders("", {}, formText)
				) {
					throw new Error(
						"Local execute secret-aware fetch does not support FormData bodies with secret placeholders; use string, Blob, or Uint8Array.",
					);
				}
				if (
					!__kodyRequestHasSecretPlaceholders(url, headers, null)
				) {
					return __kodyNativeFetch(input, init);
				}
				const encoded = new Request(url, {
					method,
					headers,
					body,
				});
				// Keep the pre-Request url string so path {{secret:…}}
				// placeholders are not percent-encoded by Request.
				method = encoded.method;
				headers = Object.fromEntries(encoded.headers.entries());
				bodyBytes = new Uint8Array(await encoded.arrayBuffer());
				reuseOriginal = false;
			} else if (__kodyIsCallerByteStream(body)) {
				// Streams cannot be replayed. Scan with a bounded holdback and
				// forward the same bytes as a stream. A placeholder fails closed
				// instead of buffering the body for a gateway hop.
				if (__kodyRequestHasSecretPlaceholders(url, headers, null)) {
					throw __kodyStreamingHeaderError();
				}
				streamingBody = __kodyScanStreamingBody(body);
				reuseOriginal = false;
			} else if (typeof Blob !== "undefined" && body instanceof Blob) {
				const blobHasSecret = await __kodyBlobHasSecretPlaceholder(body);
				if (
					!blobHasSecret &&
					!__kodyRequestHasSecretPlaceholders(url, headers, null)
				) {
					streamingBody = body;
					reuseOriginal = false;
					if (body.type) {
						const hasContentType = Object.keys(headers).some(
							(key) => key.toLowerCase() === "content-type",
						);
						if (!hasContentType) {
							headers["content-type"] = body.type;
						}
					}
				} else {
					bodyBytes = await __kodyBodyToBytes(body);
					reuseOriginal = false;
					if (body.type) {
						const hasContentType = Object.keys(headers).some(
							(key) => key.toLowerCase() === "content-type",
						);
						if (!hasContentType) {
							headers["content-type"] = body.type;
						}
					}
				}
			} else {
				bodyBytes = await __kodyBodyToBytes(body);
			}
		}
	} else {
		const merged = new Request(input, init);
		url = merged.url;
		method = merged.method;
		headers = Object.fromEntries(merged.headers.entries());
		if (method !== "GET" && method !== "HEAD" && merged.body) {
			if (__kodyIsCallerByteStream(init?.body)) {
				if (__kodyRequestHasSecretPlaceholders(url, headers, null)) {
					throw __kodyStreamingHeaderError();
				}
				streamingBody = __kodyScanStreamingBody(merged.body);
				reuseOriginal = false;
			} else {
				// String, bytes, and URLSearchParams become streams inside a
				// Request. Probe a clone and forward the original Request so
				// cache, credentials, and redirect replay stay intact. Caller
				// ReadableStream bodies are handled above.
				bodyBytes = new Uint8Array(await merged.clone().arrayBuffer());
				reuseOriginal = false;
				preservedRequest = merged;
			}
		} else {
			preservedRequest = merged;
		}
	}
	const bodyText =
		bodyBytes != null ? new TextDecoder().decode(bodyBytes) : null;
	if (streamingBody != null) {
		const fallbackInit = {
			method,
			headers,
			body: streamingBody,
		};
		if (__kodyIsCallerByteStream(streamingBody)) {
			fallbackInit.duplex = "half";
		}
		const source = init ?? {};
		const requestSource = input instanceof Request ? input : null;
		for (const key of [
			"cache",
			"credentials",
			"integrity",
			"keepalive",
			"mode",
			"redirect",
			"referrer",
			"referrerPolicy",
			"signal",
		]) {
			const value =
				source[key] != null
					? source[key]
					: requestSource
						? requestSource[key]
						: null;
			if (value != null) fallbackInit[key] = value;
		}
		return __kodyNativeFetch(url, fallbackInit);
	}
	if (!__kodyRequestHasSecretPlaceholders(url, headers, bodyText)) {
		if (reuseOriginal) {
			return __kodyNativeFetch(input, init);
		}
		if (preservedRequest) {
			return __kodyNativeFetch(preservedRequest);
		}
		const fallbackInit = {
			method,
			headers,
			...(bodyBytes != null ? { body: bodyBytes } : {}),
		};
		const signal =
			init?.signal ?? (input instanceof Request ? input.signal : null);
		if (signal != null) fallbackInit.signal = signal;
		const redirect =
			init?.redirect ?? (input instanceof Request ? input.redirect : null);
		if (redirect != null) fallbackInit.redirect = redirect;
		return __kodyNativeFetch(url, fallbackInit);
	}
	const contentType = Object.entries(headers).find(
		([key]) => key.toLowerCase() === "content-type",
	)?.[1];
	// Multipart bodies are opaque to the fetch gateway. Fail closed only when
	// placeholders are in the body itself; header/URL secrets still hop so
	// authenticated uploads match cloud executeGatewayFetch.
	if (
		typeof contentType === "string" &&
		contentType.toLowerCase().includes("multipart/") &&
		bodyText != null &&
		__kodyRequestHasSecretPlaceholders("", {}, bodyText)
	) {
		throw new Error(
			"Local execute secret-aware fetch does not support FormData bodies with secret placeholders; use string, Blob, or Uint8Array.",
		);
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
