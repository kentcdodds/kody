import { type BuildAction } from 'remix/fetch-router'
import { Layout } from '#server/layout.ts'
import { render } from '#server/render.ts'
import { type routes } from '#server/routes.ts'

export const home = {
	middleware: [],
	async action() {
		return render(Layout({}))
	},
} satisfies BuildAction<typeof routes.home.method, typeof routes.home.pattern>
