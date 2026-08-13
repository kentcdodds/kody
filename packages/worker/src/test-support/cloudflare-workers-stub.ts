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

type StubSpan = {
	readonly isTraced: boolean
	setAttribute(key: string, value?: boolean | number | string): void
	end(): void
}

const stubSpan: StubSpan = {
	isTraced: false,
	setAttribute() {},
	end() {},
}

export function waitUntil(promise: Promise<unknown>): void {
	void Promise.resolve(promise).catch(() => {})
}

export const tracing = {
	enterSpan<T, A extends Array<unknown>>(
		_name: string,
		callback: (span: StubSpan, ...args: A) => T,
		...args: A
	): T {
		return callback(stubSpan, ...args)
	},
	startActiveSpan<T, A extends Array<unknown>>(
		_name: string,
		callback: (span: StubSpan, ...args: A) => T,
		...args: A
	): T {
		return callback(stubSpan, ...args)
	},
}

export const exports = {
	KodyFetchGateway() {
		return async (request: Request) => fetch(request)
	},
} satisfies Record<string, unknown>
