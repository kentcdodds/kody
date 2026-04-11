# Raw MCP content blocks

By default, `execute` serializes its return value as a single `text` content
block. When you need to return a non-text block - most commonly an `image` for
screenshots or charts - return an object with a `__mcpContent` array instead:

```js
async () => {
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
that support vision receive image blocks as real image input, not as an
embedded base64 string inside text.

Use this only when the return value is genuinely a non-text content block. For
normal structured data, return plain values and let `execute` serialize them.
