import {
	DynamicWorkerExecutor,
	normalizeCode,
	type ExecuteResult,
} from '@cloudflare/codemode'

const charsPerToken = 4
const maxTokens = 6_000
const maxChars = maxTokens * charsPerToken

export function createExecuteExecutor(env: Env) {
	return new DynamicWorkerExecutor({
		loader: env.LOADER,
		timeout: 90_000,
	})
}

export function wrapExecuteCode(code: string) {
	const normalized = normalizeCode(code)
	return normalizeCode(`async () => {
  const listSecrets = async (options = {}) => {
    const result = await codemode.secret_list(options);
    return Array.isArray(result?.secrets) ? result.secrets : [];
  };
  const getSecret = async (name, options = {}) => {
    const result = await codemode.secret_get({
      name,
      ...(options && typeof options === 'object' ? options : {}),
    });
    if (!result || result.found !== true || typeof result.value !== 'string') {
      return null;
    }
    if (typeof result.scope === 'string') {
      console.log(\`Secret used: \${result.scope}:\${name}\`);
    }
    return result.value;
  };
  const requireSecret = async (name, options = {}) => {
    const value = await getSecret(name, options);
    if (value === null) {
      throw new Error(\`Secret not found: \${name}\`);
    }
    return value;
  };
  const secrets = {
    list: listSecrets,
    get: getSecret,
    require: requireSecret,
  };
  const userCode = (${normalized});
  return await userCode();
}`)
}

export function formatExecutionOutput(result: ExecuteResult) {
	if (result.error) return `Error: ${result.error}`
	return truncateExecutionResult(result.result)
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
