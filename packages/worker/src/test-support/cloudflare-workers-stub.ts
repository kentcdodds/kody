export class DurableObject<TEnv = unknown> {
	protected readonly state: unknown
	protected readonly env: TEnv

	constructor(state: unknown, env: TEnv) {
		this.state = state
		this.env = env
	}
}

export class RpcTarget {}
