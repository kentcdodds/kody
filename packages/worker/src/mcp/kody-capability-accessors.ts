import { type CapabilitySpec } from '#mcp/capabilities/types.ts'

export type KodyCapabilityNamespace = 'remote' | 'mcp' | 'openapi'

export type KodyCapabilityNamespaceConfig = {
	namespace: KodyCapabilityNamespace
	flatNamePrefix: `${KodyCapabilityNamespace}:`
	flatNameLabel: string
	entryNamePlaceholder: string
	toolNamePlaceholder: string
}

export const kodyCapabilityNamespaceConfigs = {
	remote: {
		namespace: 'remote',
		flatNamePrefix: 'remote:',
		flatNameLabel: 'Remote connector capability',
		entryNamePlaceholder: 'connectorName',
		toolNamePlaceholder: 'capabilityName',
	},
	mcp: {
		namespace: 'mcp',
		flatNamePrefix: 'mcp:',
		flatNameLabel: 'MCP server tool',
		entryNamePlaceholder: 'serverName',
		toolNamePlaceholder: 'toolName',
	},
	openapi: {
		namespace: 'openapi',
		flatNamePrefix: 'openapi:',
		flatNameLabel: 'OpenAPI operation',
		entryNamePlaceholder: 'providerName',
		toolNamePlaceholder: 'operationSlug',
	},
} satisfies Record<KodyCapabilityNamespace, KodyCapabilityNamespaceConfig>

type AccessorNameMode = 'literal' | 'expression'

export function buildNamespacedKodyAccessor(input: {
	namespace: KodyCapabilityNamespace
	entryName: string
	toolName: string
	entryNameMode?: AccessorNameMode
	toolNameMode?: AccessorNameMode
}) {
	const entryAccessor = `kody.${input.namespace}[${
		input.entryNameMode === 'expression'
			? input.entryName
			: JSON.stringify(input.entryName)
	}]`
	if (input.toolNameMode === 'expression') {
		return `${entryAccessor}.${input.toolName}`
	}
	if (isJavaScriptIdentifier(input.toolName)) {
		return `${entryAccessor}.${input.toolName}`
	}
	return `${entryAccessor}[${JSON.stringify(input.toolName)}]`
}

export function buildKodyCapabilityAccessor(spec: {
	name: string
	source?: CapabilitySpec['source']
	remoteConnector?: CapabilitySpec['remoteConnector']
	mcpServer?: CapabilitySpec['mcpServer']
	openApi?: CapabilitySpec['openApi']
}) {
	if (spec.source === 'remote-connector' && spec.remoteConnector) {
		return buildNamespacedKodyAccessor({
			namespace: 'remote',
			entryName: spec.remoteConnector.connectorName,
			toolName: spec.remoteConnector.toolName,
		})
	}
	if (spec.source === 'mcp-server' && spec.mcpServer) {
		return buildNamespacedKodyAccessor({
			namespace: 'mcp',
			entryName: spec.mcpServer.kodyName,
			toolName: spec.mcpServer.toolName,
		})
	}
	if (spec.source === 'openapi' && spec.openApi) {
		return buildNamespacedKodyAccessor({
			namespace: 'openapi',
			entryName: spec.openApi.kodyName,
			toolName: spec.openApi.operationSlug,
		})
	}
	const { name } = spec
	if (isJavaScriptIdentifier(name)) {
		return `kody.${name}`
	}
	return `kody[${JSON.stringify(name)}]`
}

export function buildKodyFlatCapabilityHint(
	namespace: KodyCapabilityNamespace,
) {
	const config = kodyCapabilityNamespaceConfigs[namespace]
	return `${buildNamespacedKodyAccessor({
		namespace: config.namespace,
		entryName: config.entryNamePlaceholder,
		toolName: config.toolNamePlaceholder,
		entryNameMode: 'expression',
		toolNameMode: 'expression',
	})}(input)`
}

export function buildKodyFlatCapabilityUnavailableMessage(input: {
	namespace: KodyCapabilityNamespace
	flatToolName: string
}) {
	const config = kodyCapabilityNamespaceConfigs[input.namespace]
	return `${config.flatNameLabel} "${input.flatToolName}" is not available as a flat kody function. Use ${buildKodyFlatCapabilityHint(input.namespace)} instead.`
}

function isJavaScriptIdentifier(value: string) {
	return /^[A-Za-z_$][\w$]*$/.test(value)
}
