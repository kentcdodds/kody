import { type Action } from 'remix/router'
import { Layout } from '#app/layout.ts'
import { render } from '#app/render.ts'
import { type routes } from '#app/routes.ts'

export const privacy = {
	middleware: [],
	async handler() {
		return render(Layout({}))
	},
} satisfies Action<typeof routes.privacy>
