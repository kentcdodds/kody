# Benchmarks and related packages

Source: https://github.com/remix-run/remix/tree/main/packages/multipart-parser

## Demos

The
[`demos` directory](https://github.com/remix-run/remix/tree/main/packages/multipart-parser/demos)
contains working demos:

- [`demos/bun`](https://github.com/remix-run/remix/tree/main/packages/multipart-parser/demos/bun) -
  using multipart-parser in Bun
- [`demos/cf-workers`](https://github.com/remix-run/remix/tree/main/packages/multipart-parser/demos/cf-workers) -
  using multipart-parser in a Cloudflare Worker and storing file uploads in R2
- [`demos/deno`](https://github.com/remix-run/remix/tree/main/packages/multipart-parser/demos/deno) -
  using multipart-parser in Deno
- [`demos/node`](https://github.com/remix-run/remix/tree/main/packages/multipart-parser/demos/node) -
  using multipart-parser in Node.js

## Benchmark

`multipart-parser` is designed to be as efficient as possible, operating on
streams of data and rarely buffering in common usage. This design yields
exceptional performance when handling multipart payloads of any size. In
benchmarks, `multipart-parser` is as fast or faster than `busboy`.

The results of running the benchmarks on my laptop:

```
> @remix-run/multipart-parser@0.10.1 bench:node /Users/michael/Projects/remix-the-web/packages/multipart-parser
> node --disable-warning=ExperimentalWarning ./bench/runner.ts

Platform: Darwin (24.5.0)
CPU: Apple M1 Pro
Date: 6/13/2025, 12:27:09 PM
Node.js v24.0.2
(index) | 1 small file | 1 large file | 100 small files | 5 large files
multipart-parser | '0.01 ms +/- 0.03' | '1.08 ms +/- 0.08' | '0.04 ms +/- 0.01' | '10.50 ms +/- 0.38'
multipasta | '0.02 ms +/- 0.06' | '1.07 ms +/- 0.02' | '0.15 ms +/- 0.02' | '10.46 ms +/- 0.11'
busboy | '0.06 ms +/- 0.17' | '3.07 ms +/- 0.24' | '0.24 ms +/- 0.05' | '29.85 ms +/- 0.18'
@fastify/busboy | '0.05 ms +/- 0.13' | '1.23 ms +/- 0.09' | '0.45 ms +/- 0.22' | '11.81 ms +/- 0.11'

> @remix-run/multipart-parser@0.10.1 bench:bun /Users/michael/Projects/remix-the-web/packages/multipart-parser
> bun run ./bench/runner.ts

Platform: Darwin (24.5.0)
CPU: Apple M1 Pro
Date: 6/13/2025, 12:27:31 PM
Bun 1.2.13
(index) | 1 small file | 1 large file | 100 small files | 5 large files
multipart-parser | 0.01 ms +/- 0.04 | 0.86 ms +/- 0.09 | 0.04 ms +/- 0.01 | 8.32 ms +/- 0.26
multipasta | 0.02 ms +/- 0.07 | 0.87 ms +/- 0.03 | 0.25 ms +/- 0.21 | 8.27 ms +/- 0.09
busboy | 0.05 ms +/- 0.17 | 3.54 ms +/- 0.10 | 0.30 ms +/- 0.03 | 34.79 ms +/- 0.38
@fastify/busboy | 0.06 ms +/- 0.18 | 4.04 ms +/- 0.08 | 0.48 ms +/- 0.06 | 39.91 ms +/- 0.37

> @remix-run/multipart-parser@0.10.1 bench:deno /Users/michael/Projects/remix-the-web/packages/multipart-parser
> deno run --allow-sys ./bench/runner.ts

Platform: Darwin (24.5.0)
CPU: Apple M1 Pro
Date: 6/13/2025, 12:28:12 PM
Deno 2.3.6
(idx) | 1 small file | 1 large file | 100 small files | 5 large files
multipart-parser | "0.01 ms +/- 0.03" | "1.03 ms +/- 0.04" | "0.05 ms +/- 0.01" | "10.05 ms +/- 0.20"
multipasta | "0.02 ms +/- 0.07" | "1.04 ms +/- 0.03" | "0.16 ms +/- 0.02" | "10.10 ms +/- 0.08"
busboy | "0.05 ms +/- 0.19" | "3.06 ms +/- 0.15" | "0.32 ms +/- 0.05" | "29.92 ms +/- 0.24"
@fastify/busboy | "0.06 ms +/- 0.14" | "14.72 ms +/- 11.42" | "0.81 ms +/- 0.20" | "127.63 ms +/- 35.77"
```

## Related packages

- [`form-data-parser`](https://github.com/remix-run/remix/tree/main/packages/form-data-parser) -
  Uses `multipart-parser` internally to parse multipart requests and generate
  `FileUpload`s for storage
- [`headers`](https://github.com/remix-run/remix/tree/main/packages/headers) -
  Used internally to parse HTTP headers and get metadata (filename, content
  type) for each `MultipartPart`

## Credits

Thanks to Jacob Ebey who gave me several code reviews on this project prior to
publishing.

## License

See [LICENSE](https://github.com/remix-run/remix/blob/main/LICENSE)

## Navigation

- [multipart-parser overview](./index.md)
- [Remix package index](../index.md)
