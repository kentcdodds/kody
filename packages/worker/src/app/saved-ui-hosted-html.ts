import {
	absolutizeSrcset,
	absolutizeUrl,
	buildShellStyles,
	decodeHtmlAttribute,
	escapeHtmlAttribute,
	injectThemeAttributeIntoHtmlTag,
	type ThemeName,
} from '@kody-internal/shared/generated-ui-utils.ts'
import { type GeneratedUiAppSession } from '#mcp/generated-ui-app-session.ts'
import { type UiArtifactRow } from '#mcp/ui-artifacts-types.ts'

type HostedSavedUiInput = {
	artifact: UiArtifactRow
	appSession: GeneratedUiAppSession
	appBaseUrl: string
}

export function renderHostedSavedUiHtml(input: HostedSavedUiInput) {
	const runtime =
		input.artifact.runtime === 'javascript' ? 'javascript' : 'html'
	if (runtime === 'javascript') {
		const injection = buildHeadInjection({
			appSession: input.appSession,
			includeRuntime: false,
		})
		const runtimeSource = buildHostedWidgetRuntimeSource(input.appSession)
		return buildJavascriptDocument(
			input.artifact.code,
			injection,
			runtimeSource,
		)
	}

	const injection = buildHeadInjection({
		appSession: input.appSession,
		includeRuntime: true,
	})
	const htmlSource = /<(?:!doctype|html|head|body)\b/i.test(input.artifact.code)
		? injectIntoHtmlDocument(input.artifact.code, injection, null)
		: buildHtmlDocumentFromFragment(input.artifact.code, injection, null)
	return absolutizeHtmlAttributeUrls(htmlSource, input.appBaseUrl)
}

function buildJavascriptDocument(
	code: string,
	injection: string,
	runtimeSource: string,
) {
	const safeCode = escapeInlineScriptSource(code)
	const moduleSource = `
${runtimeSource}
${safeCode}
	`.trim()
	return `
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		${injection}
	</head>
	<body data-kody-runtime="javascript">
		<div id="app" data-generated-ui-root></div>
		<script type="module">
${moduleSource}
		</script>
	</body>
</html>
	`.trim()
}

function buildHtmlDocumentFromFragment(
	code: string,
	injection: string,
	theme: ThemeName | null,
) {
	return `
<!doctype html>
<html lang="en"${theme ? ` data-kody-theme="${theme}"` : ''}>
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		${injection}
	</head>
	<body data-kody-runtime="fragment">
${code}
	</body>
</html>
	`.trim()
}

function buildHeadInjection(input: {
	appSession: GeneratedUiAppSession
	includeRuntime: boolean
}) {
	const styles = `
<style>
${buildShellStyles(null)}
</style>
	`.trim()
	if (!input.includeRuntime) {
		return styles
	}
	return `
${styles}
<script>
${buildHostedWidgetRuntimeSource(input.appSession)}
</script>
	`.trim()
}

function buildHostedWidgetRuntimeSource(appSession: GeneratedUiAppSession) {
	const sessionPayload = JSON.stringify({
		token: appSession.token,
		endpoints: appSession.endpoints,
	})
	const script = `
const appSession = ${sessionPayload};
const sessionToken = appSession && typeof appSession.token === 'string' ? appSession.token : null;
const sessionEndpoints = appSession && typeof appSession.endpoints === 'object' ? appSession.endpoints : null;
function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function coerceStorageScope(value) {
	return value === 'session' || value === 'app' || value === 'user' ? value : null;
}
function coerceValueMetadata(value) {
	if (!isRecord(value)) return null;
	const scope = coerceStorageScope(value.scope);
	if (
		typeof value.name !== 'string' ||
		typeof value.value !== 'string' ||
		typeof value.description !== 'string' ||
		scope == null ||
		(value.app_id != null && typeof value.app_id !== 'string') ||
		typeof value.created_at !== 'string' ||
		typeof value.updated_at !== 'string' ||
		(value.ttl_ms != null &&
			(typeof value.ttl_ms !== 'number' ||
				!Number.isFinite(value.ttl_ms) ||
				value.ttl_ms < 0))
	) {
		return null;
	}
	return {
		name: value.name,
		scope,
		value: value.value,
		description: value.description,
		app_id: value.app_id ?? null,
		created_at: value.created_at,
		updated_at: value.updated_at,
		ttl_ms: value.ttl_ms ?? null,
	};
}
function buildCodemodeCapabilityExecuteCode(name, args) {
	return [
		'async () => {',
		'  return await codemode[' + JSON.stringify(name) + '](' + JSON.stringify(args ?? {}) + ');',
		'}',
	].join('\\n');
}
function normalizeSecretNameList(values) {
	return Array.from(new Set(values.filter((value) => typeof value === 'string' && value.length > 0)));
}
function extractSecretNamesFromValue(value, collected = []) {
	if (typeof value === 'string') {
		for (const match of value.matchAll(/\\{\\{secret:([a-zA-Z0-9._-]+)/g)) {
			if (match[1]) collected.push(match[1]);
		}
		return collected;
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			extractSecretNamesFromValue(entry, collected);
		}
		return collected;
	}
	if (isRecord(value)) {
		for (const entry of Object.values(value)) {
			extractSecretNamesFromValue(entry, collected);
		}
	}
	return collected;
}
function extractApprovalDetails(message, fallbackSecretNames = []) {
	const text = typeof message === 'string' ? message : String(message ?? '');
	const secretNames = normalizeSecretNameList([
		...Array.from(text.matchAll(/Secret "([^"]+)"/g)).map((match) => match[1]).filter(Boolean),
		...fallbackSecretNames,
	]);
	const hostMatch = text.match(/host "([^"]+)"/);
	let approvalUrl = null;
	for (const part of text.split(/\\s+/)) {
		if (part.startsWith('http://') || part.startsWith('https://')) {
			approvalUrl = part.replace(/[),.;]+$/, '');
			break;
		}
	}
	return {
		message: text,
		approvalUrl,
		host: hostMatch ? hostMatch[1] : null,
		secretNames,
	};
}
function resolveFormReference(formRef) {
	if (typeof formRef === 'string') {
		return document.querySelector(formRef);
	}
	return formRef && typeof formRef === 'object' ? formRef : null;
}
function formDataToObject(formData) {
	const result = {};
	for (const name of new Set(formData.keys())) {
		const all = formData.getAll(name);
		result[name] = all.length > 1 ? all : (all[0] ?? null);
	}
	return result;
}
function pickLastFormValue(value) {
	if (Array.isArray(value)) {
		return value.length > 0 ? value[value.length - 1] : null;
	}
	return value ?? null;
}
function toStringArray(value) {
	if (Array.isArray(value)) {
		return value.map((entry) => (typeof entry === 'string' ? entry : String(entry)));
	}
	if (value == null) return [];
	return [typeof value === 'string' ? value : String(value)];
}
function setControlValues(form, name, values) {
	const controls = Array.from(form.elements).filter((element) => {
		return element && typeof element === 'object' && 'name' in element && element.name === name;
	});
	if (controls.length === 0) return;
	for (const control of controls) {
		if (!control || typeof control !== 'object') continue;
		if ('type' in control && (control.type === 'checkbox' || control.type === 'radio')) {
			const controlValue = typeof control.value === 'string' && control.value.length > 0 ? control.value : 'on';
			control.checked = values.includes(controlValue) || (control.type === 'checkbox' && controlValue === 'on' && values.some((value) => value === 'true' || value === '1' || value === 'on'));
			continue;
		}
		if ('multiple' in control && control.multiple && 'options' in control && control.options) {
			for (const option of Array.from(control.options)) {
				option.selected = values.includes(option.value);
			}
			continue;
		}
		if ('value' in control) {
			control.value = values.length > 0 ? values[values.length - 1] : '';
		}
	}
}
function getTopLocationUrl(inputUrl) {
	if (inputUrl) {
		return new URL(inputUrl, window.location.href);
	}
	try {
		if (window.top && window.top.location && window.top.location.href) {
			return new URL(window.top.location.href);
		}
	} catch {}
	return new URL(window.location.href);
}
function normalizeFetchWithSecretsInput(input) {
	if (!isRecord(input)) {
		return { ok: false, error: 'fetchWithSecrets input must be an object.' };
	}
	if (typeof input.url !== 'string' || input.url.length === 0) {
		return { ok: false, error: 'fetchWithSecrets requires a url.' };
	}
	const headers = {};
	if (isRecord(input.headers)) {
		for (const [key, value] of Object.entries(input.headers)) {
			if (typeof value === 'string') {
				headers[key] = value;
			}
		}
	}
	let body = input.body;
	if (body != null && typeof body !== 'string') {
		body = JSON.stringify(body);
		const hasContentType = Object.keys(headers).some((key) => key.toLowerCase() === 'content-type');
		if (!hasContentType) {
			headers['Content-Type'] = 'application/json';
		}
	}
	return {
		ok: true,
		value: {
			url: input.url,
			method: typeof input.method === 'string' && input.method.length > 0 ? input.method.toUpperCase() : 'GET',
			headers,
			body: typeof body === 'string' ? body : undefined,
		},
	};
}
function buildFetchWithSecretsExecuteCode(input) {
	return [
		'async () => {',
		'  const response = await fetch(' + JSON.stringify(input.url) + ', {',
		'    method: ' + JSON.stringify(input.method) + ',',
		'    headers: ' + JSON.stringify(input.headers) + ',',
		input.body != null ? '    body: ' + JSON.stringify(input.body) + ',' : '',
		'  });',
		'  const headers = Object.fromEntries(response.headers.entries());',
		'  const contentType = response.headers.get("content-type") || "";',
		'  const text = await response.text();',
		'  let data = null;',
		'  if (/\\\\bjson\\\\b/i.test(contentType) && text) {',
		'    try {',
		'      data = JSON.parse(text);',
		'    } catch {}',
		'  }',
		'  return {',
		'    ok: response.ok,',
		'    status: response.status,',
		'    headers,',
		'    data,',
		'    text: text || null,',
		'  };',
		'}',
	].filter(Boolean).join('\\n');
}
function normalizeFetchWithSecretsResult(result) {
	if (!isRecord(result)) {
		return {
			ok: false,
			kind: 'execution_error',
			message: 'fetchWithSecrets returned an invalid result.',
		};
	}
	const headers = isRecord(result.headers)
		? Object.fromEntries(
				Object.entries(result.headers).filter((entry) => typeof entry[1] === 'string'),
			)
		: {};
	const status = typeof result.status === 'number' ? result.status : 0;
	const text =
		typeof result.text === 'string' || result.text == null ? result.text : null;
	const data = 'data' in result ? result.data : null;
	if (result.ok === true) {
		return {
			ok: true,
			status,
			headers,
			data,
			text,
		};
	}
	return {
		ok: false,
		kind: 'http_error',
		status,
		headers,
		data,
		text,
	};
}
function getApiErrorMessage(payload, fallback) {
	return typeof payload?.error === 'string' ? payload.error : fallback;
}
function getSessionRequestTarget(type) {
	if (!sessionToken || !sessionEndpoints) {
		return null;
	}
	const url =
		type === 'execute'
			? sessionEndpoints.execute
			: type === 'secrets'
				? sessionEndpoints.secrets
				: sessionEndpoints.deleteSecret;
	if (typeof url !== 'string' || url.length === 0) {
		return null;
	}
	return { url, token: sessionToken };
}
async function fetchJsonResponse(input) {
	const headers = new Headers({
		Accept: 'application/json',
	});
	if (input.body) {
		headers.set('Content-Type', 'application/json');
	}
	if (input.token) {
		headers.set('Authorization', 'Bearer ' + input.token);
	}
	const response = await fetch(input.url, {
		method: input.method ?? 'GET',
		headers,
		body: input.body ? JSON.stringify(input.body) : undefined,
		cache: 'no-store',
		credentials: input.token ? 'omit' : 'include',
	});
	const payload = await response.json().catch(() => null);
	return { response, payload };
}
async function executeCodeWithHttp(code) {
	const target = getSessionRequestTarget('execute');
	if (!target) {
		throw new Error('Code execution is unavailable in this context.');
	}
	const { response, payload } = await fetchJsonResponse({
		url: target.url,
		method: 'POST',
		body: { code },
		token: target.token,
	});
	if (!response.ok || !payload || payload.ok !== true) {
		throw new Error(getApiErrorMessage(payload, 'Code execution failed.'));
	}
	return payload.result ?? null;
}
async function saveSecretWithHttp(input) {
	const target = getSessionRequestTarget('secrets');
	if (!target) {
		return {
			ok: false,
			error: 'Secret storage is unavailable in this context.',
		};
	}
	const { response, payload } = await fetchJsonResponse({
		url: target.url,
		method: 'POST',
		body: {
			name: input.name,
			value: input.value,
			description: input.description ?? '',
			...(input.scope ? { scope: input.scope } : {}),
		},
		token: target.token,
	});
	if (!response.ok || !payload || payload.ok !== true) {
		return {
			ok: false,
			error: getApiErrorMessage(payload, 'Unable to save secret.'),
		};
	}
	return {
		ok: true,
		secret: isRecord(payload.secret) ? payload.secret : undefined,
	};
}
async function listSecretsWithHttp(scope) {
	const target = getSessionRequestTarget('secrets');
	if (!target) return [];
	const url = new URL(target.url);
	if (scope) {
		url.searchParams.set('scope', scope);
	}
	const { response, payload } = await fetchJsonResponse({
		url: url.toString(),
		method: 'GET',
		token: target.token,
	});
	if (!response.ok || !Array.isArray(payload?.secrets)) {
		throw new Error(getApiErrorMessage(payload, 'Unable to list secrets.'));
	}
	return payload.secrets.filter((secret) => {
		return (
			isRecord(secret) &&
			typeof secret.name === 'string' &&
			coerceStorageScope(secret.scope) != null &&
			typeof secret.description === 'string' &&
			(secret.app_id == null || typeof secret.app_id === 'string') &&
			Array.isArray(secret.allowed_hosts) &&
			secret.allowed_hosts.every((host) => typeof host === 'string') &&
			Array.isArray(secret.allowed_capabilities) &&
			secret.allowed_capabilities.every(
				(capability) => typeof capability === 'string',
			) &&
			typeof secret.created_at === 'string' &&
			typeof secret.updated_at === 'string' &&
			(secret.ttl_ms == null ||
				(typeof secret.ttl_ms === 'number' &&
					Number.isFinite(secret.ttl_ms) &&
					secret.ttl_ms >= 0))
		);
	});
}
async function deleteSecretWithHttp(input) {
	const target = getSessionRequestTarget('delete-secret');
	if (!target) {
		return {
			ok: false,
			error: 'Secret storage is unavailable in this context.',
		};
	}
	const { response, payload } = await fetchJsonResponse({
		url: target.url,
		method: 'POST',
		body: {
			name: input.name,
			...(input.scope ? { scope: input.scope } : {}),
		},
		token: target.token,
	});
	if (!response.ok || !payload || payload.ok !== true) {
		return {
			ok: false,
			error: getApiErrorMessage(payload, 'Unable to delete secret.'),
		};
	}
	return {
		ok: true,
		deleted: payload.deleted === true,
	};
}
function getOAuthStorage() {
	try {
		return window.localStorage;
	} catch {
		return window.sessionStorage;
	}
}
window.kodyWidget = {
	sendMessage(text) {
		if (typeof text === 'string' && text.length > 0) {
			console.info('[kodyWidget] message:', text);
		}
		return false;
	},
	openLink(url) {
		if (typeof url !== 'string' || url.length === 0) return false;
		window.open(url, '_blank', 'noopener,noreferrer');
		return true;
	},
	async toggleFullscreen() {
		return 'inline';
	},
	async executeCode(code) {
		if (typeof code !== 'string' || code.length === 0) return null;
		return await executeCodeWithHttp(code);
	},
	async saveSecret(input) {
		if (!input || typeof input !== 'object') {
			return { ok: false, error: 'Secret input must be an object.' };
		}
		if (typeof input.name !== 'string' || input.name.length === 0) {
			return { ok: false, error: 'Secret name is required.' };
		}
		if (typeof input.value !== 'string' || input.value.length === 0) {
			return { ok: false, error: 'Secret value is required.' };
		}
		const response = await saveSecretWithHttp(input);
		return response && typeof response === 'object'
			? response
			: { ok: false, error: 'Unable to save secret.' };
	},
	async saveSecrets(input) {
		if (!Array.isArray(input)) {
			return {
				ok: false,
				results: [
					{
						name: '',
						ok: false,
						error: 'Secret inputs must be an array.',
					},
				],
			};
		}
		const results = [];
		for (const item of input) {
			if (!item || typeof item !== 'object') {
				results.push({
					name: '',
					ok: false,
					error: 'Each secret input must be an object.',
				});
				continue;
			}
			const response = await this.saveSecret(item);
			results.push({
				name: typeof item.name === 'string' ? item.name : '',
				ok: response.ok === true,
				...(response.secret ? { secret: response.secret } : {}),
				...(response.ok === true ? {} : { error: response.error || 'Unable to save secret.' }),
			});
		}
		return {
			ok: results.every((result) => result.ok === true),
			results,
		};
	},
	async saveValue(input) {
		if (!input || typeof input !== 'object') {
			return { ok: false, error: 'Value input must be an object.' };
		}
		if (typeof input.name !== 'string' || input.name.length === 0) {
			return { ok: false, error: 'Value name is required.' };
		}
		if (typeof input.value !== 'string' || input.value.length === 0) {
			return { ok: false, error: 'Value is required.' };
		}
		try {
			const result = await this.executeCode(
				buildCodemodeCapabilityExecuteCode('value_set', {
					name: input.name,
					value: input.value,
					description: typeof input.description === 'string' ? input.description : '',
					...(coerceStorageScope(input.scope) ? { scope: input.scope } : {}),
				}),
			);
			const saved = coerceValueMetadata(isRecord(result) ? result.value : null);
			if (!saved) {
				return { ok: false, error: 'Unable to save value.' };
			}
			return {
				ok: true,
				value: saved,
			};
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : 'Unable to save value.',
			};
		}
	},
	async saveValues(input) {
		if (!Array.isArray(input)) {
			return {
				ok: false,
				results: [
					{
						name: '',
						ok: false,
						error: 'Value inputs must be an array.',
					},
				],
			};
		}
		const results = [];
		for (const item of input) {
			if (!item || typeof item !== 'object') {
				results.push({
					name: '',
					ok: false,
					error: 'Each value input must be an object.',
				});
				continue;
			}
			const response = await this.saveValue(item);
			results.push({
				name: typeof item.name === 'string' ? item.name : '',
				ok: response.ok === true,
				...(response.value ? { value: response.value } : {}),
				...(response.ok === true ? {} : { error: response.error || 'Unable to save value.' }),
			});
		}
		return {
			ok: results.every((result) => result.ok === true),
			results,
		};
	},
	async getValue(input) {
		if (!input || typeof input !== 'object') {
			throw new Error('Value input must be an object.');
		}
		if (typeof input.name !== 'string' || input.name.length === 0) {
			throw new Error('Value name is required.');
		}
		const result = await this.executeCode(
			buildCodemodeCapabilityExecuteCode('value_get', {
				name: input.name,
				...(coerceStorageScope(input.scope) ? { scope: input.scope } : {}),
			}),
		);
		return coerceValueMetadata(isRecord(result) ? result.value : null);
	},
	async listValues(input) {
		const scope = coerceStorageScope(isRecord(input) ? input.scope : undefined);
		const result = await this.executeCode(
			buildCodemodeCapabilityExecuteCode('value_list', {
				...(scope ? { scope } : {}),
			}),
		);
		if (!isRecord(result) || !Array.isArray(result.values)) return [];
		return result.values
			.map((value) => coerceValueMetadata(value))
			.filter((value) => value != null);
	},
	async deleteValue(input) {
		if (!input || typeof input !== 'object') {
			return { ok: false, error: 'Value input must be an object.' };
		}
		if (typeof input.name !== 'string' || input.name.length === 0) {
			return { ok: false, error: 'Value name is required.' };
		}
		const scope = coerceStorageScope(input.scope);
		if (!scope) {
			return { ok: false, error: 'Value scope is required.' };
		}
		try {
			const result = await this.executeCode(
				buildCodemodeCapabilityExecuteCode('value_delete', {
					name: input.name,
					scope,
				}),
			);
			return {
				ok: true,
				deleted: isRecord(result) ? result.deleted === true : false,
			};
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : 'Unable to delete value.',
			};
		}
	},
	async listSecrets(input) {
		const scope = coerceStorageScope(isRecord(input) ? input.scope : undefined);
		try {
			const response = await listSecretsWithHttp(scope ?? undefined);
			return Array.isArray(response) ? response : [];
		} catch {
			return [];
		}
	},
	formToObject(form) {
		const resolvedForm = resolveFormReference(form);
		if (!(resolvedForm instanceof HTMLFormElement)) {
			throw new Error('formToObject requires an HTMLFormElement or a selector that resolves to one.');
		}
		return formDataToObject(new FormData(resolvedForm));
	},
	fillFromSearchParams(form, mapping) {
		const resolvedForm = resolveFormReference(form);
		if (!(resolvedForm instanceof HTMLFormElement)) {
			throw new Error('fillFromSearchParams requires an HTMLFormElement or a selector that resolves to one.');
		}
		const url = getTopLocationUrl();
		const fieldNames = new Set(
			Array.from(resolvedForm.elements)
				.map((element) => ('name' in element ? element.name : ''))
				.filter(Boolean),
		);
		for (const name of fieldNames) {
			const paramName =
				isRecord(mapping) && typeof mapping[name] === 'string' && mapping[name].length > 0
					? mapping[name]
					: name;
			const values = url.searchParams.getAll(paramName);
			if (values.length === 0) continue;
			setControlValues(resolvedForm, name, values);
		}
		return this.formToObject(resolvedForm);
	},
	persistForm(form, options) {
		const resolvedForm = resolveFormReference(form);
		if (!(resolvedForm instanceof HTMLFormElement)) {
			throw new Error('persistForm requires an HTMLFormElement or a selector that resolves to one.');
		}
		if (!isRecord(options) || typeof options.storageKey !== 'string' || options.storageKey.length === 0) {
			throw new Error('persistForm requires a storageKey option.');
		}
		const values = this.formToObject(resolvedForm);
		const fieldNames = Array.isArray(options.fields)
			? options.fields.filter((field) => typeof field === 'string' && field.length > 0)
			: Object.keys(values);
		const persisted = {};
		for (const name of fieldNames) {
			if (!(name in values)) continue;
			const value = values[name];
			const normalized = Array.isArray(value)
				? value.filter((entry) => typeof entry === 'string').map((entry) => entry)
				: typeof value === 'string'
					? value
					: null;
			if (normalized != null) {
				persisted[name] = normalized;
			}
		}
		localStorage.setItem(options.storageKey, JSON.stringify(persisted));
		return persisted;
	},
	restoreForm(form, options) {
		const resolvedForm = resolveFormReference(form);
		if (!(resolvedForm instanceof HTMLFormElement)) {
			throw new Error('restoreForm requires an HTMLFormElement or a selector that resolves to one.');
		}
		if (!isRecord(options) || typeof options.storageKey !== 'string' || options.storageKey.length === 0) {
			throw new Error('restoreForm requires a storageKey option.');
		}
		const raw = localStorage.getItem(options.storageKey);
		if (!raw) return null;
		let parsed = null;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return null;
		}
		if (!isRecord(parsed)) return null;
		for (const [name, value] of Object.entries(parsed)) {
			setControlValues(resolvedForm, name, toStringArray(value));
		}
		return this.formToObject(resolvedForm);
	},
	createOAuthState(key) {
		if (typeof key !== 'string' || key.length === 0) {
			throw new Error('createOAuthState requires a storage key.');
		}
		const state =
			globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
				? globalThis.crypto.randomUUID()
				: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
		const storage = getOAuthStorage();
		storage.setItem(key, state);
		return state;
	},
	getOAuthState(key) {
		if (typeof key !== 'string' || key.length === 0) return null;
		const storage = getOAuthStorage();
		return storage.getItem(key);
	},
	clearOAuthState(key) {
		if (typeof key !== 'string' || key.length === 0) return;
		const storage = getOAuthStorage();
		storage.removeItem(key);
	},
	validateOAuthCallbackState(input) {
		if (!isRecord(input) || typeof input.key !== 'string' || input.key.length === 0) {
			throw new Error('validateOAuthCallbackState requires a key.');
		}
		const storage = getOAuthStorage();
		const expectedState = storage.getItem(input.key);
		const returnedState =
			typeof input.returnedState === 'string' && input.returnedState.length > 0
				? input.returnedState
				: null;
		return {
			valid:
				typeof expectedState === 'string' &&
				expectedState.length > 0 &&
				returnedState != null &&
				expectedState === returnedState,
			expectedState,
			returnedState,
		};
	},
	readOAuthCallback(input) {
		const url = getTopLocationUrl(isRecord(input) && typeof input.url === 'string' ? input.url : undefined);
		const error = url.searchParams.get('error');
		const errorDescription = url.searchParams.get('error_description');
		if (error) {
			return {
				kind: 'error',
				error,
				errorDescription,
				callbackUrl: url.toString(),
			};
		}
		const code = url.searchParams.get('code');
		if (!code) {
			return { kind: 'none' };
		}
		const storage = getOAuthStorage();
		const state = url.searchParams.get('state');
		const expectedState =
			isRecord(input) && typeof input.expectedStateKey === 'string'
				? storage.getItem(input.expectedStateKey)
				: null;
		return {
			kind: 'success',
			code,
			state,
			callbackUrl: url.toString(),
			expectedState,
			stateMatches:
				expectedState != null && state != null ? expectedState === state : null,
		};
	},
	async fetchWithSecrets(input) {
		const normalized = normalizeFetchWithSecretsInput(input);
		if (!normalized.ok) {
			return {
				ok: false,
				kind: 'execution_error',
				message: normalized.error,
			};
		}
		const fallbackSecretNames = normalizeSecretNameList(
			extractSecretNamesFromValue([
				normalized.value.url,
				Object.values(normalized.value.headers),
				normalized.value.body,
			]),
		);
		try {
			const result = await this.executeCode(
				buildFetchWithSecretsExecuteCode(normalized.value),
			);
			return normalizeFetchWithSecretsResult(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes('not allowed for host')) {
				const approval = extractApprovalDetails(message, fallbackSecretNames);
				return {
					ok: false,
					kind: 'host_approval_required',
					approvalUrl: approval.approvalUrl,
					message: approval.message,
					host: approval.host,
					secretNames: approval.secretNames,
				};
			}
			return {
				ok: false,
				kind: 'execution_error',
				message,
			};
		}
	},
	async exchangeOAuthCode(input) {
		if (!isRecord(input)) {
			return {
				ok: false,
				kind: 'execution_error',
				message: 'exchangeOAuthCode input must be an object.',
			};
		}
		if (
			typeof input.tokenUrl !== 'string' ||
			typeof input.code !== 'string' ||
			typeof input.redirectUri !== 'string' ||
			typeof input.clientIdSecretName !== 'string' ||
			typeof input.clientSecretSecretName !== 'string' ||
			input.tokenUrl.length === 0 ||
			input.code.length === 0 ||
			input.redirectUri.length === 0 ||
			input.clientIdSecretName.length === 0 ||
			input.clientSecretSecretName.length === 0
		) {
			return {
				ok: false,
				kind: 'execution_error',
				message: 'exchangeOAuthCode requires tokenUrl, code, redirectUri, clientIdSecretName, and clientSecretSecretName.',
			};
		}
		const scope = coerceStorageScope(input.scope);
		const scopeSuffix = scope ? '|scope=' + scope : '';
		const params = new URLSearchParams();
		params.set('grant_type', 'authorization_code');
		params.set('client_id', '{{secret:' + input.clientIdSecretName + scopeSuffix + '}}');
		params.set('client_secret', '{{secret:' + input.clientSecretSecretName + scopeSuffix + '}}');
		params.set('code', input.code);
		params.set('redirect_uri', input.redirectUri);
		if (isRecord(input.extraParams)) {
			for (const [key, value] of Object.entries(input.extraParams)) {
				if (value == null) continue;
				params.set(key, typeof value === 'string' ? value : String(value));
			}
		}
		return await this.fetchWithSecrets({
			url: input.tokenUrl,
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: params.toString(),
		});
	},
	async saveOAuthTokens(input) {
		if (!isRecord(input) || !isRecord(input.payload)) {
			return {
				ok: false,
				accessTokenSaved: false,
				refreshTokenSaved: false,
				error: 'saveOAuthTokens requires a payload object.',
				results: [],
			};
		}
		if (typeof input.accessTokenSecretName !== 'string' || input.accessTokenSecretName.length === 0) {
			return {
				ok: false,
				accessTokenSaved: false,
				refreshTokenSaved: false,
				error: 'saveOAuthTokens requires an accessTokenSecretName.',
				results: [],
			};
		}
		const accessToken = typeof input.payload.access_token === 'string' ? input.payload.access_token : '';
		const refreshToken = typeof input.payload.refresh_token === 'string' ? input.payload.refresh_token : '';
		if (!accessToken) {
			return {
				ok: false,
				accessTokenSaved: false,
				refreshTokenSaved: false,
				error: 'OAuth payload did not include an access_token.',
				results: [],
			};
		}
		const secrets = [
			{
				name: input.accessTokenSecretName,
				value: accessToken,
				description:
					typeof input.accessTokenDescription === 'string'
						? input.accessTokenDescription
						: 'OAuth access token',
				scope: coerceStorageScope(input.scope) ?? undefined,
			},
		];
		if (refreshToken && typeof input.refreshTokenSecretName === 'string' && input.refreshTokenSecretName.length > 0) {
			secrets.push({
				name: input.refreshTokenSecretName,
				value: refreshToken,
				description:
					typeof input.refreshTokenDescription === 'string'
						? input.refreshTokenDescription
						: 'OAuth refresh token',
				scope: coerceStorageScope(input.scope) ?? undefined,
			});
		}
		const saved = await this.saveSecrets(secrets);
		return {
			ok: saved.ok,
			accessTokenSaved: saved.results.some((result) => result.name === input.accessTokenSecretName && result.ok === true),
			refreshTokenSaved:
				typeof input.refreshTokenSecretName === 'string' && input.refreshTokenSecretName.length > 0
					? saved.results.some((result) => result.name === input.refreshTokenSecretName && result.ok === true)
					: false,
			error: saved.ok ? undefined : (saved.results.find((result) => result.ok !== true)?.error || 'Unable to save OAuth tokens.'),
			results: saved.results,
		};
	},
	buildSecretForm(input) {
		if (!isRecord(input) || !Array.isArray(input.fields)) {
			throw new Error('buildSecretForm requires a form config object with fields.');
		}
		const form = resolveFormReference(input.form);
		if (!(form instanceof HTMLFormElement)) {
			throw new Error('buildSecretForm requires an HTMLFormElement or a selector that resolves to one.');
		}
		const controller = {
			form,
			save: async () => {
				const values = window.kodyWidget.formToObject(form);
				const secrets = input.fields.map((field) => {
					if (!field || typeof field !== 'object') {
						throw new Error('Each secret field config must be an object.');
					}
					if (typeof field.inputName !== 'string' || field.inputName.length === 0) {
						throw new Error('Each secret field config requires inputName.');
					}
					if (typeof field.secretName !== 'string' || field.secretName.length === 0) {
						throw new Error('Each secret field config requires secretName.');
					}
					const rawValue = pickLastFormValue(values[field.inputName]);
					if (typeof rawValue !== 'string' || rawValue.length === 0) {
						throw new Error('Form field "' + field.inputName + '" is required.');
					}
					return {
						name: field.secretName,
						value: rawValue,
						description:
							typeof field.description === 'string' ? field.description : '',
						scope: coerceStorageScope(field.scope) ?? undefined,
					};
				});
				const result = await window.kodyWidget.saveSecrets(secrets);
				if (result.ok) {
					if (typeof input.onSuccess === 'function') {
						await input.onSuccess(result, values);
					}
				} else if (typeof input.onError === 'function') {
					await input.onError(result, values);
				}
				return result;
			},
			destroy: () => {
				form.removeEventListener('submit', handleSubmit);
			},
		};
		async function handleSubmit(event) {
			event.preventDefault();
			try {
				await controller.save();
			} catch (error) {
				if (typeof input.onError === 'function') {
					await input.onError(
						{
							ok: false,
							results: [
								{
									name: '',
									ok: false,
									error:
										error instanceof Error ? error.message : String(error),
								},
							],
						},
						window.kodyWidget.formToObject(form),
					);
					return;
				}
				throw error;
			}
		}
		form.addEventListener('submit', handleSubmit);
		return controller;
	},
	async deleteSecret(input) {
		if (!input || typeof input !== 'object') {
			return { ok: false, error: 'Secret input must be an object.' };
		}
		if (typeof input.name !== 'string' || input.name.length === 0) {
			return { ok: false, error: 'Secret name is required.' };
		}
		const response = await deleteSecretWithHttp(input);
		return response && typeof response === 'object'
			? response
			: { ok: false, error: 'Unable to delete secret.' };
	},
};
window.addEventListener('error', (event) => {
	console.error(
		'Generated UI app error:',
		event.error?.message ?? event.message ?? event.error ?? 'Unknown error',
	);
});
window.addEventListener('unhandledrejection', (event) => {
	console.error(
		'Generated UI app rejection:',
		event.reason?.message ?? event.reason ?? 'Unknown rejection',
	);
});
	`.trim()
	return escapeInlineScriptSource(script)
}

function escapeInlineScriptSource(code: string) {
	return code.replace(/<\/script/gi, '<\\/script')
}

function injectIntoHtmlDocument(
	code: string,
	injection: string,
	theme: ThemeName | null,
) {
	if (/<head\b[^>]*>/i.test(code)) {
		const withTheme = theme
			? code.replace(/<html\b[^>]*>/i, (match) =>
					injectThemeAttributeIntoHtmlTag(match, theme),
				)
			: code

		return withTheme.replace(
			/<head\b[^>]*>/i,
			(match) => `${match}\n${injection}\n`,
		)
	}

	if (/<html\b[^>]*>/i.test(code)) {
		return code.replace(
			/<html\b[^>]*>/i,
			(match) =>
				`${injectThemeAttributeIntoHtmlTag(match, theme)}<head>${injection}</head>`,
		)
	}

	if (/<body\b[^>]*>/i.test(code)) {
		return code.replace(/<body\b[^>]*>/i, (match) => `${match}\n${injection}\n`)
	}

	if (/<\/body>/i.test(code)) {
		return code.replace(/<\/body>/i, `${injection}\n</body>`)
	}

	return `${injection}\n${code}`
}
function absolutizeHtmlAttributeUrls(code: string, baseHref: string | null) {
	if (!baseHref) {
		return code
	}

	const tagPattern = /<[^>]+>/g
	let insideScript = false
	let insideStyle = false

	return code.replace(tagPattern, (tag) => {
		if (insideScript) {
			if (/^<\/\s*script\b/i.test(tag)) {
				insideScript = false
			}
			return tag
		}

		if (insideStyle) {
			if (/^<\/\s*style\b/i.test(tag)) {
				insideStyle = false
			}
			return tag
		}

		if (
			tag.startsWith('<!--') ||
			tag.startsWith('<!') ||
			tag.startsWith('<?')
		) {
			return tag
		}

		const nextTag = tag.replace(
			/(^|\s)(href|src|action|formaction|poster|srcset)=("([^"]*)"|'([^']*)')/gi,
			(
				match,
				prefix,
				attributeName,
				quotedValue,
				doubleQuotedValue,
				singleQuotedValue,
			) => {
				const rawValue =
					typeof doubleQuotedValue === 'string'
						? doubleQuotedValue
						: singleQuotedValue
				const decodedValue = decodeHtmlAttribute(rawValue)
				const nextValue =
					attributeName.toLowerCase() === 'srcset'
						? absolutizeSrcset(decodedValue, baseHref)
						: absolutizeUrl(decodedValue, baseHref)

				if (nextValue === decodedValue) {
					return match
				}

				const quote = quotedValue.startsWith('"') ? '"' : "'"
				return `${prefix}${attributeName}=${quote}${escapeHtmlAttribute(nextValue)}${quote}`
			},
		)

		if (/^<\s*script\b/i.test(tag) && !/\/\s*>$/.test(tag)) {
			insideScript = true
		} else if (/^<\s*style\b/i.test(tag) && !/\/\s*>$/.test(tag)) {
			insideStyle = true
		}

		return nextTag
	})
}
