# App task patterns

Small, copyable **codemode** patterns for **app tasks** or **`execute`**.
Prefer app tasks over new builtin capabilities when the workflow does not
require Worker-only primitives (billing bindings, secret storage, etc.).

| Pattern                                                        | Summary                                                                                                        |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [cloudflare-api-v4.md](./cloudflare-api-v4.md)                 | Call Cloudflare API v4 with secret-aware `fetch` to `api.cloudflare.com` (replaces removed `cloudflare_rest`). |
| [cloudflare-developer-docs.md](./cloudflare-developer-docs.md) | Fetch markdown from `developers.cloudflare.com` with an allowlisted path and return a bounded preview.         |
