export class DurableObject<TEnv = unknown> {
	protected readonly state: unknown
	protected readonly env: TEnv

	constructor(state: unknown, env: TEnv) {
		this.state = state
		this.env = env
	}
}

export class WorkerEntrypoint<TEnv = unknown, TProps = unknown> {
	protected readonly ctx: { props: TProps }
	protected readonly env: TEnv

	constructor(ctx: { props: TProps }, env: TEnv) {
		this.ctx = ctx
		this.env = env
	}
}

export class RpcTarget {}

export const exports = {}
