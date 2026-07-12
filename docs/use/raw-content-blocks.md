# Raw MCP content blocks

By default, `execute` serializes its return value as a single `text` content
block. When you need to return a non-text block - most commonly an `image` for
screenshots or charts - return an object with a `__mcpContent` array instead:

```js
export default async function main(input = {}) {
	void input
	// ... fetch or generate image data ...
	return {
		__mcpContent: [
			{ type: 'image', data: base64, mimeType: 'image/png' },
			{ type: 'text', text: 'Description of the image' },
		],
	}
}
```

The blocks are passed through directly as the MCP tool result content. Agents
that support vision receive image blocks as real image input, not as an embedded
base64 string inside text.

Use this only when the return value is genuinely a non-text content block. For
normal structured data, return plain values and let `execute` serialize them.

## Size limits

`execute` has two separate caps:

- **`responseLimit`** (~100 KB by default) applies to ordinary JSON/text return
  values (and to structured companion data alongside protocol content).
- **Protocol content** from `__mcpContent` (and from downstream MCP / remote
  connector tools that pass through images, audio, or resources) uses a separate
  ~512 KB serialized-content cap. Base64 expands binary by about 4/3, so a ~133
  KB WebP is roughly ~177 KB of JSON and fits; oversized protocol content fails
  explicitly instead of being truncated into unusable JSON text.

## Downstream MCP servers and remote connectors

When execute code calls a user-added MCP server (`kody.mcp[...]`) or remote
connector (`kody.remote[...]`) and returns that capability result directly, Kody
preserves protocol-valid MCP content blocks from the downstream tool — including
`image`, `audio`, `resource`, and `resource_link` — and passes them through to
the upstream MCP client.

If the downstream tool returns both `structuredContent` and non-text `content`,
structured data stays available for code (and in execute’s
`structuredContent.result`) while the content blocks still pass through.

Image and audio blocks must already be protocol-valid
`{ type: 'image' | 'audio', data, mimeType }` with base64 `data`. Kody does not
fetch image URLs from third-party payloads (SSRF / host-approval risk).
Malformed blocks fail with a source-specific error naming the MCP server,
connector tool, or execute `__mcpContent` return.
