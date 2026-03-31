# Skill patterns

Small, copyable **codemode** patterns for **`meta_save_skill`** / **`execute`**.
Prefer skills over new builtin capabilities when the workflow does not require
Worker-only primitives (billing bindings, secret storage, etc.).

| Pattern                                                        | Summary                                                                                                         |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [cloudflare-api-v4.md](./cloudflare-api-v4.md)                 | Call Cloudflare API v4 with secret-aware `fetch` to `api.cloudflare.com` (replaces removed `cloudflare_rest`).  |
| [cloudflare-developer-docs.md](./cloudflare-developer-docs.md) | Fetch markdown from `developers.cloudflare.com` with an allowlisted path; optional `page_to_markdown` fallback. |
