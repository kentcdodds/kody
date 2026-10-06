import gss from 'gss-lang/vite'
import { type Plugin } from 'vite'

/**
 * Compile `.gss` scenes with `gss-lang/vite`. That plugin skips any module
 * id with a query, but Vite dev requests a file type it does not know as
 * `scene.gss?import`, so the scene would load as raw text. Strip that query
 * before GSS sees the id.
 */
export function gssScenes(): Plugin {
	const plugin = gss()
	const { transform } = plugin
	if (typeof transform !== 'function') return plugin
	return {
		...plugin,
		transform(source, id, options) {
			return transform.call(this, source, id.replace(/\?import$/, ''), options)
		},
	}
}
