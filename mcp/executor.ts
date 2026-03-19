import {
	DynamicWorkerExecutor,
	normalizeCode,
	type ExecuteResult,
} from '@cloudflare/codemode'
import { type CapabilitySpec } from './capabilities/types.ts'

const charsPerToken = 4
const maxTokens = 6_000
const maxChars = maxTokens * charsPerToken

export function createSearchExecutor(
	env: Env,
	capabilities: Record<string, CapabilitySpec>,
	domains: Record<string, string>,
) {
	return new DynamicWorkerExecutor({
		loader: env.LOADER,
		timeout: 30_000,
		modules: {
			'capabilities.js': createCapabilitiesModuleSource(capabilities, domains),
		},
	})
}

export function createExecuteExecutor(env: Env) {
	return new DynamicWorkerExecutor({
		loader: env.LOADER,
		timeout: 30_000,
	})
}

export function wrapSearchCode(code: string) {
	const normalizedCode = normalizeCode(code)

	return [
		'async () => {',
		'  const { capabilities, domains, getCapability, getDomain, listDomains, findCapabilities } = await import("capabilities.js");',
		`  const run = ${normalizedCode};`,
		'  return await run();',
		'}',
	].join('\n')
}

export function wrapExecuteCode(code: string) {
	return normalizeCode(code)
}

export function formatExecutionOutput(result: ExecuteResult) {
	if (result.error) return `Error: ${result.error}`
	return truncateExecutionResult(result.result)
}

function createCapabilitiesModuleSource(
	capabilities: Record<string, CapabilitySpec>,
	domains: Record<string, string>,
) {
	return `
const capabilities = ${JSON.stringify(capabilities, null, 2)};
const domains = ${JSON.stringify(domains, null, 2)};

function createCapabilitySummary(capability) {
	return {
		name: capability.name,
		domain: capability.domain,
		requiredInputFields: capability.requiredInputFields,
	};
}

function createDetailedCapabilitySummary(capability) {
	const summary = {
		name: capability.name,
		domain: capability.domain,
		description: capability.description,
		keywords: capability.keywords,
		readOnly: capability.readOnly,
		idempotent: capability.idempotent,
		destructive: capability.destructive,
		requiredInputFields: capability.requiredInputFields,
		inputSchema: capability.inputSchema,
		outputSchema: capability.outputSchema,
	};

	if (!capability.inputSchema) {
		summary.inputFields = capability.inputFields;
	}

	if (!capability.outputSchema) {
		summary.outputFields = capability.outputFields;
	}

	return summary;
}

export { capabilities };
export { domains };

export function getCapability(name) {
	return capabilities[name];
}

export function getDomain(name) {
	return domains[name];
}

export function listDomains() {
	return Object.entries(domains).map(([name, description]) => ({
		name,
		description,
	}));
}

export function findCapabilities(query = {}) {
	const text = typeof query.text === "string" ? query.text.trim().toLowerCase() : "";
	const domain =
		typeof query.domain === "string" ? query.domain.trim().toLowerCase() : "";
	const keyword =
		typeof query.keyword === "string"
			? query.keyword.trim().toLowerCase()
				: "";
	const inputField =
		typeof query.inputField === "string"
			? query.inputField.trim().toLowerCase()
			: "";
	const outputField =
		typeof query.outputField === "string"
			? query.outputField.trim().toLowerCase()
			: "";
	const readOnly =
		typeof query.readOnly === "boolean" ? query.readOnly : undefined;
	const idempotent =
		typeof query.idempotent === "boolean" ? query.idempotent : undefined;
	const destructive =
		typeof query.destructive === "boolean" ? query.destructive : undefined;
	const detail = query.detail === true;

	return Object.values(capabilities)
		.filter((capability) => {
			if (domain && capability.domain.toLowerCase() !== domain) return false;
			if (
				keyword &&
				!capability.keywords.some(
					(value) => value.toLowerCase() === keyword,
				)
			) {
				return false;
			}
			if (
				inputField &&
				!capability.inputFields.some(
					(value) => value.toLowerCase() === inputField,
				)
			) {
				return false;
			}
			if (
				outputField &&
				!capability.outputFields.some(
					(value) => value.toLowerCase() === outputField,
				)
			) {
				return false;
			}
			if (
				text &&
				![
					capability.name,
					capability.domain,
					capability.description,
					...capability.keywords,
					...capability.inputFields,
					...capability.outputFields,
				]
					.join(" ")
					.toLowerCase()
					.includes(text)
			) {
				return false;
			}
			if (readOnly !== undefined && capability.readOnly !== readOnly) return false;
			if (idempotent !== undefined && capability.idempotent !== idempotent) {
				return false;
			}
			if (destructive !== undefined && capability.destructive !== destructive) {
				return false;
			}
			return true;
		})
		.map(detail ? createDetailedCapabilitySummary : createCapabilitySummary);
}
`.trim()
}

function truncateExecutionResult(value: unknown) {
	const text =
		typeof value === 'string'
			? value
			: (JSON.stringify(value, null, 2) ?? 'undefined')

	if (text.length <= maxChars) return text

	return `${text.slice(0, maxChars)}\n\n--- TRUNCATED ---\nResponse was ~${Math.ceil(
		text.length / charsPerToken,
	).toLocaleString()} tokens (limit: ${maxTokens.toLocaleString()}). Use more specific queries to reduce response size.`
}
