import { type BuildAction } from 'remix/fetch-router'
import { Layout } from '#app/layout.ts'
import { render } from '#app/render.ts'
import { type routes } from '#app/routes.ts'

export const home = {
	middleware: [],
	async handler() {
		return render(Layout({}))
	},
} satisfies BuildAction<typeof routes.home.method, typeof routes.home.pattern>
