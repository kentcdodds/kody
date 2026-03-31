# response

Source: https://github.com/remix-run/remix/tree/main/packages/response

## Overview

Response helpers for the web Fetch API. `response` provides a collection of
helper functions for creating common HTTP responses with proper headers and
semantics.

## Features

- **Web Standards Compliant:** Built on the standard `Response` API, works in
  any JavaScript runtime (Node.js, Bun, Deno, Cloudflare Workers)
- **File Responses:** Full HTTP semantics including ETags, Last-Modified,
  conditional requests, and Range support
- **HTML Responses:** Automatic DOCTYPE prepending and proper Content-Type
  headers
- **Redirect Responses:** Simple redirect creation with customizable status
  codes
- **Compress Responses:** Streaming compression based on Accept-Encoding header

## Installation

```sh
npm install @remix-run/response
```

## Usage

This package provides no default export. Instead, import the specific helper you
need:

```ts
import { createFileResponse } from '@remix-run/response/file'
import { createHtmlResponse } from '@remix-run/response/html'
import { createRedirectResponse } from '@remix-run/response/redirect'
import { compressResponse } from '@remix-run/response/compress'
```

## Navigation

- [File responses](./file-responses.md)
- [HTML responses](./html-responses.md)
- [Redirect responses](./redirect-responses.md)
- [Compressed responses](./compress-responses.md)
- [Related packages](./related.md)
- [Remix package index](../index.md)
