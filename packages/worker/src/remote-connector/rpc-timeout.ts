/**
 * Deadline for one remote-connector JSON-RPC round trip (`tools/list` or
 * `tools/call`). Enforced inside the session Durable Object and again at
 * the Worker caller so a stuck hibernatable WebSocket handler cannot hold
 * `rpcCallTool` until a 270s workflow sandbox observe timeout.
 */
export const remoteConnectorRpcTimeoutMs = 15_000

export function remoteConnectorRpcTimeoutMessage(method: string) {
	return `Timed out waiting for remote connector response to ${method}.`
}
