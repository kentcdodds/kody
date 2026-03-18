# headers

Source: https://github.com/remix-run/remix/tree/main/packages/headers

## Overview

Utilities for parsing, manipulating and stringifying HTTP header values.

HTTP headers contain critical information - from content negotiation and caching
directives to authentication tokens and file metadata. While the native
`Headers` API provides a basic string-based interface, it leaves the
complexities of parsing specific header formats entirely up to you.

## Installation

```sh
bun add @remix-run/headers
```

## Header utilities

- Accept headers: [accept-headers](./accept-headers.md)
- Content and cache headers: [content-headers](./content-headers.md)
- Cookies: [cookie-headers](./cookie-headers.md)
- Conditionals and ranges: [conditional-headers](./conditional-headers.md)
- Raw header parsing: [raw-headers](./raw-headers.md)

## Navigation

- [Remix package index](../index.md)
