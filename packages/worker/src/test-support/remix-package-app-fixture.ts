/**
 * A mid-complexity Remix package app used by the workers bundling test and
 * the MCP end-to-end test: a typed route contract, a controller with a GET
 * page and a POST action that validates form data and persists through
 * `packageStorage()`, a custom middleware that sets a context key, an SSR
 * document, and one hydrated `clientEntry` island booted by the browser
 * entry. It is the shape `docs/guides/package-apps.md` documents, so the
 * tests prove the recipe as written.
 */
export function createRemixPackageAppFiles(input: {
	username: string
	kodyId: string
	/** Declares `kody.app.runtime` (default `true`); pass `false` to exercise inference. */
	declareRuntime?: boolean
}): Record<string, string> {
	const packageJson = {
		name: `@${input.username}/${input.kodyId}`,
		private: true,
		exports: { '.': './src/index.ts' },
		// Types only: publish installs `dependencies`, never `devDependencies`,
		// so the platform copy of remix is what the bundle uses.
		devDependencies: { remix: '3.0.0-rc.2' },
		kody: {
			id: input.kodyId,
			description: 'Remix mini-app fixture: routes, action, middleware, SSR',
			app: {
				...(input.declareRuntime === false ? {} : { runtime: 'remix' }),
				entry: './app/router.ts',
				client: './app/assets/entry.ts',
				assets: './public',
			},
		},
	}
	return {
		'package.json': `${JSON.stringify(packageJson, null, '\t')}\n`,
		'README.md':
			'# Remix notes\n\n## Intent\n\nProve a package app can be a hosted Remix mini-app with Kody in the request context.\n',
		'AGENTS.md': [
			'# Agents',
			'',
			'Remix mini-app on the Kody package-app runtime (`kody.app.runtime: "remix"`).',
			'',
			'- Import Remix as `remix/<subpath>`; the platform supplies it. Never add',
			'  `@remix-run/*` or `remix` to `dependencies` (publish rejects `@remix-run/*`).',
			'- Routes live in `app/routes.ts`, prefixed with `packageContext.appBasePath`;',
			'  build every URL with `routes.x.href()`, never a root-relative literal.',
			'- Controllers in `app/controllers/` read Kody through `get(KodyRuntime)`.',
			'- Islands in `app/ui/` are named `clientEntry` functions registered in',
			'  `app/assets/entry.ts`; static files and `sw.js` live in `public/`.',
			'',
		].join('\n'),
		'src/index.ts':
			'export default async function main() {\n\treturn { ok: true }\n}\n',
		'app/routes.ts': `import { packageContext } from 'kody:runtime'
import { form, route } from 'remix/routes'

// Hosted apps live under a mount (/packages/<id> on the subdomain). Prefixing
// the contract keeps every href(), redirect, and form action inside it.
export const routes = route(packageContext?.appBasePath ?? '', {
	home: '/',
	notes: form('notes'),
	health: '/healthz',
})
`,
		'app/router.ts': `import { createRouter } from 'remix/router'
import { formData } from 'remix/middleware/form-data'
import { requestId } from './middleware/request-id.ts'
import { routes } from './routes.ts'
import home from './controllers/home.tsx'
import notes from './controllers/notes.tsx'

const router = createRouter({ middleware: [requestId(), formData()] })

router.map(routes.home, home)
router.map(routes.notes, notes)
router.get(routes.health, () => Response.json({ ok: true }))

export default router
`,
		'app/middleware/request-id.ts': `import { createContextKey, type Middleware } from 'remix/router'

export const RequestId = createContextKey<string>()

export function requestId(): Middleware {
	return async (context, next) => {
		context.set(RequestId, crypto.randomUUID())
		const response = await next()
		response.headers.set('x-request-id', context.get(RequestId) ?? '')
		return response
	}
}
`,
		'app/data/notes.ts': `import { KodyRuntime } from 'kody:runtime'
import type { RequestContext } from 'remix/router'

export type Note = { id: string; text: string }

const notesKey = 'notes'

export async function listNotes(context: RequestContext): Promise<Array<Note>> {
	const storage = context.get(KodyRuntime).packageStorage()
	const stored = await storage.get(notesKey)
	return Array.isArray(stored) ? (stored as Array<Note>) : []
}

export async function addNote(context: RequestContext, text: string) {
	const storage = context.get(KodyRuntime).packageStorage()
	const notes = await listNotes(context)
	const note: Note = { id: crypto.randomUUID(), text }
	await storage.set(notesKey, [...notes, note])
	return note
}
`,
		'app/controllers/home.tsx': `import type { BuildAction } from 'remix/router'
import { KodyRuntime } from 'kody:runtime'
import { listNotes } from '../data/notes.ts'
import { RequestId } from '../middleware/request-id.ts'
import { render } from '../ui/render.tsx'
import { routes } from '../routes.ts'
import { Counter } from '../ui/counter.tsx'

export default {
	async handler(context) {
		const { packageContext } = context.get(KodyRuntime)
		const notes = await listNotes(context)
		return render(
			context,
			<main>
				<h1 id="title">Remix notes</h1>
				<p id="mount">Mounted at {packageContext?.appBasePath ?? '/'}</p>
				<p id="request-id">{context.get(RequestId) ?? 'no-request-id'}</p>
				<Counter initialCount={notes.length} label="Notes" />
				<a href={routes.notes.index.href()}>Add a note</a>
			</main>,
		)
	},
} satisfies BuildAction<'ANY', typeof routes.home>
`,
		'app/controllers/notes.tsx': `import type { Controller } from 'remix/router'
import * as s from 'remix/data-schema'
import * as f from 'remix/data-schema/form-data'
import { redirect } from 'remix/response/redirect'
import { addNote, listNotes } from '../data/notes.ts'
import { render } from '../ui/render.tsx'
import { routes } from '../routes.ts'

const noteSchema = f.object({
	text: f.field(s.string()),
})

export default {
	actions: {
		async index(context) {
			const notes = await listNotes(context)
			return render(
				context,
				<main>
					<h1>Notes</h1>
					<ul id="notes">
						{notes.map((note) => (
							<li key={note.id}>{note.text}</li>
						))}
					</ul>
					<form method="post" action={routes.notes.action.href()}>
						<input name="text" />
						<button type="submit">Add</button>
					</form>
				</main>,
			)
		},
		async action(context) {
			const parsed = s.parseSafe(noteSchema, context.get(FormData))
			if (!parsed.success || parsed.value.text.trim().length === 0) {
				return render(
					context,
					<main>
						<h1>Notes</h1>
						<p id="error">A note needs some text.</p>
					</main>,
					{ status: 400 },
				)
			}
			await addNote(context, parsed.value.text.trim())
			return redirect(routes.notes.index.href(), 303)
		},
	},
} satisfies Controller<typeof routes.notes>
`,
		'app/ui/render.tsx': `import type { RequestContext } from 'remix/router'
import { KodyRuntime } from 'kody:runtime'
import type { RemixNode } from 'remix/ui'
import { renderToStream } from 'remix/ui/server'
import { createHtmlResponse } from 'remix/response/html'
import { Document } from './document.tsx'

export function render(
	context: RequestContext,
	children: RemixNode,
	init?: ResponseInit,
) {
	const { packageContext } = context.get(KodyRuntime)
	const stream = renderToStream(
		<Document
			appBasePath={packageContext?.appBasePath ?? ''}
			assetBasePath={packageContext?.assetBasePath ?? ''}
			clientModuleUrl={packageContext?.clientModuleUrl ?? null}
		>
			{children}
		</Document>,
		{
			frameSrc: context.url.href,
			onError(error) {
				console.error('SSR render error:', error)
			},
		},
	)
	return createHtmlResponse(stream, init)
}
`,
		'app/ui/layout.tsx': `import type { Handle, RemixNode } from 'remix/ui'
import { routes } from '../routes.ts'

// Server-only: imports the route contract (and so kody:runtime). Islands must
// not import this module; they receive hrefs as props.
export function Layout(handle: Handle<{ children?: RemixNode }>) {
	return () => (
		<div class="layout">
			<nav id="nav">
				<a href={routes.home.href()}>Home</a>
				<a href={routes.notes.index.href()}>Notes</a>
			</nav>
			{handle.props.children}
		</div>
	)
}
`,
		'app/ui/document.tsx': `import type { Handle, RemixNode } from 'remix/ui'
import { Layout } from './layout.tsx'

export function Document(
	handle: Handle<{
		appBasePath: string
		assetBasePath: string
		clientModuleUrl: string | null
		children?: RemixNode
	}>,
) {
	return () => (
		<html lang="en" data-app-base={handle.props.appBasePath}>
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>Remix notes</title>
				<link
					rel="stylesheet"
					href={\`\${handle.props.assetBasePath}/styles.css\`}
				/>
			</head>
			<body>
				<Layout>{handle.props.children}</Layout>
				{handle.props.clientModuleUrl ? (
					<script type="module" src={handle.props.clientModuleUrl}></script>
				) : null}
			</body>
		</html>
	)
}
`,
		'app/ui/counter.tsx': `import { clientEntry, on, type Handle } from 'remix/ui'

export const Counter = clientEntry(
	import.meta.url,
	function Counter(handle: Handle<{ initialCount: number; label: string }>) {
		let count = handle.props.initialCount
		return () => (
			<button
				id="counter"
				type="button"
				mix={on('click', () => {
					count += 1
					handle.update()
				})}
			>
				{handle.props.label}: {count}
			</button>
		)
	},
)
`,
		'app/assets/entry.ts': `import { run } from 'remix/ui'
import { Counter } from '../ui/counter.tsx'

// One browser module, so hydration resolves exports here instead of by URL.
const clientEntries: Record<string, unknown> = { Counter }

const app = run({
	async loadModule(_moduleUrl, exportName) {
		const component = clientEntries[exportName]
		if (typeof component !== 'function') {
			throw new Error(\`Unknown client entry "\${exportName}"\`)
		}
		return component
	},
})

app.addEventListener('error', (event) => {
	console.error('Hydration error:', event.error)
})

void app.ready().then(() => {
	document.documentElement.dataset.hydrated = 'true'
})
`,
		'public/styles.css': 'body { font-family: system-ui, sans-serif; }\n',
	}
}
