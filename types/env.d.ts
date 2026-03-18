import { type AppEnv } from './env-schema.ts'

declare global {
	interface Env extends AppEnv {}

	interface CustomExportedHandler<Props = {}> {
		fetch: (
			request: Request,
			env: Env,
			ctx: ExecutionContext<Props>,
		) => Response | Promise<Response>
	}
}

export {}
