import {
	camelToSnakeIdentifier,
	snakeToCamelIdentifier,
} from '#mcp/capabilities/runtime-identifier.ts'

type KodyTool = (args: unknown) => Promise<unknown>

/**
 * Register snake_case call names beside camelCase kody tools.
 *
 * Saved packages and execute modules still call host tools as
 * `kody.integration_get`. The dispatcher only finds a tool whose name was
 * registered, and builtin capabilities are camelCase (`integrationGet`), so
 * the snake_case call throws `Tool "integration_get" not found`. The camelCase
 * function stays the canonical tool. An existing key wins, which keeps the
 * removed `value_set` stub from being replaced by a `valueSet` alias.
 */
export function aliasSnakeCaseKodyTools(
	tools: Record<string, KodyTool>,
): Record<string, KodyTool> {
	const aliased: Record<string, KodyTool> = { ...tools }
	for (const [name, tool] of Object.entries(tools)) {
		const alias = camelToSnakeIdentifier(name)
		if (alias === name || Object.hasOwn(aliased, alias)) continue
		aliased[alias] = tool
	}
	return aliased
}

/**
 * Map a sandbox tool name onto a registered capability.
 * `integration_get` resolves to `integrationGet` when that capability exists.
 * Unknown names, including `value_set`, are returned unchanged.
 */
export function resolveKodyCapabilityName(
	name: string,
	capabilities: Record<string, unknown>,
) {
	if (Object.hasOwn(capabilities, name)) return name
	const camelName = snakeToCamelIdentifier(name)
	if (camelName !== name && Object.hasOwn(capabilities, camelName)) {
		return camelName
	}
	return name
}
