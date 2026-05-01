import { type BuildAction } from 'remix/fetch-router'
import { type routes } from '../routes.ts'

export const health = {
	middleware: [],
	async handler() {
		return Response.json(
			{
				ok: true,
				service: 'home-connector',
			},
			{
				headers: {
					'Cache-Control': 'no-store',
				},
			},
		)
	},
} satisfies BuildAction<
	typeof routes.health.method,
	typeof routes.health.pattern
>
