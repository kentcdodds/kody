import {
	type KodyMcpServerMetadata,
	type KodyOpenApiProviderMetadata,
	type KodyRemoteConnectorMetadata,
} from '#mcp/kody-remote-types.ts'
import {
	assertGeneratedExecutorSourceIsBundleSafe,
	kodyRemoteProxyFactorySource,
} from '#mcp/kody-remote-proxy-source.ts'
import {
	buildKodyFlatCapabilityUnavailableMessage,
	kodyCapabilityNamespaceConfigs,
} from '#mcp/kody-capability-accessors.ts'

// Keep only fields the sandbox proxy reads so inlined executor scripts stay
// smaller and volatile status prose does not churn the stable worker-ID hash.
function projectKodyRemoteProxyMetadata(
	entries: ReadonlyArray<{
		name: string
		status: {
			connected: boolean
			toolCount: number
			unavailableMessage: string
		}
		capabilities: ReadonlyArray<{
			name: string
			dispatchName: string
		}>
	}>,
) {
	return entries.map((entry) => ({
		name: entry.name,
		status: {
			connected: entry.status.connected,
			toolCount: entry.status.toolCount,
			unavailableMessage: entry.status.unavailableMessage,
		},
		capabilities: entry.capabilities.map((capability) => ({
			name: capability.name,
			dispatchName: capability.dispatchName,
		})),
	}))
}

export function createKodyProviderProxySource(input: {
	providerName: string
	remoteConnectors: Array<KodyRemoteConnectorMetadata>
	mcpServers?: Array<KodyMcpServerMetadata>
	openApiProviders?: Array<KodyOpenApiProviderMetadata>
}) {
	const metadataJson = JSON.stringify(
		projectKodyRemoteProxyMetadata(input.remoteConnectors),
	)
	const mcpMetadataJson = JSON.stringify(
		projectKodyRemoteProxyMetadata(input.mcpServers ?? []),
	)
	const openApiMetadataJson = JSON.stringify(
		projectKodyRemoteProxyMetadata(input.openApiProviders ?? []),
	)
	const remoteFlatNameMessage = buildKodyFlatCapabilityUnavailableMessage({
		namespace: 'remote',
		flatToolName: '${normalizedToolName}',
	})
	const mcpFlatNameMessage = buildKodyFlatCapabilityUnavailableMessage({
		namespace: 'mcp',
		flatToolName: '${normalizedToolName}',
	})
	const openApiFlatNameMessage = buildKodyFlatCapabilityUnavailableMessage({
		namespace: 'openapi',
		flatToolName: '${normalizedToolName}',
	})
	const remoteFlatNamePrefix =
		kodyCapabilityNamespaceConfigs.remote.flatNamePrefix
	const mcpFlatNamePrefix = kodyCapabilityNamespaceConfigs.mcp.flatNamePrefix
	const openApiFlatNamePrefix =
		kodyCapabilityNamespaceConfigs.openapi.flatNamePrefix
	const source = `    const __kodyCreateRemoteProxy = ${kodyRemoteProxyFactorySource};
    const __kodyCallDispatcher = async (dispatchName, args) => {
      const resJson = await __dispatchers.${input.providerName}.call(dispatchName, JSON.stringify(args ?? {}));
      const data = JSON.parse(resJson);
      if (data.error) throw new Error(data.error);
      return data.result;
    };
    const __kodyRemote = __kodyCreateRemoteProxy({
      remoteConnectors: ${metadataJson},
      callTool: __kodyCallDispatcher,
    });
    const __kodyMcp = __kodyCreateRemoteProxy({
      remoteConnectors: ${mcpMetadataJson},
      entityLabel: "MCP server",
      shortEntityLabel: "MCP server",
      capabilityLabel: "MCP tool",
      callTool: __kodyCallDispatcher,
    });
    const __kodyOpenapi = __kodyCreateRemoteProxy({
      remoteConnectors: ${openApiMetadataJson},
      entityLabel: "OpenAPI provider",
      shortEntityLabel: "provider",
      capabilityLabel: "operation",
      callTool: __kodyCallDispatcher,
    });
    const ${input.providerName} = new Proxy({}, {
      get: (_, toolName) => {
        if (typeof toolName === 'symbol' || toolName === 'then') return undefined;
        if (toolName === 'remote') return __kodyRemote;
        if (toolName === 'mcp') return __kodyMcp;
        if (toolName === 'openapi') return __kodyOpenapi;
        const normalizedToolName = String(toolName);
        if (normalizedToolName.startsWith('${remoteFlatNamePrefix}')) {
          throw new Error(\`${remoteFlatNameMessage}\`);
        }
        if (normalizedToolName.startsWith('${mcpFlatNamePrefix}')) {
          throw new Error(\`${mcpFlatNameMessage}\`);
        }
        if (normalizedToolName.startsWith('${openApiFlatNamePrefix}')) {
          throw new Error(\`${openApiFlatNameMessage}\`);
        }
        return async (args) => await __kodyCallDispatcher(normalizedToolName, args);
      }
    });`
	assertGeneratedExecutorSourceIsBundleSafe(source)
	return source
}
