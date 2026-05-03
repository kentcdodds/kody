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

export class WorkflowEntrypoint<TEnv = unknown, TPayload = unknown> {
	protected readonly ctx: unknown
	protected readonly env: TEnv

	constructor(ctx: unknown, env: TEnv) {
		this.ctx = ctx
		this.env = env
	}

	run(_event: { payload: TPayload }, _step: unknown): Promise<unknown> {
		throw new Error('WorkflowEntrypoint.run must be implemented by tests.')
	}
}

export class RpcTarget {}

export const exports = {
	CodemodeFetchGateway() {
		return async (request: Request) => fetch(request)
	},
} satisfies Record<string, unknown>
