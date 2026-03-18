# file-storage-s3

Source: https://github.com/remix-run/remix/tree/main/packages/file-storage-s3

## README

S3 backend for `remix/file-storage`.

Use this package when you want the `FileStorage` API backed by AWS S3 or an
S3-compatible provider (MinIO, LocalStack, etc.).

## Installation

```sh
npm i remix
```

## Usage

```ts
import { createS3FileStorage } from 'remix/file-storage-s3'

let storage = createS3FileStorage({
	accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
	secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
	bucket: 'my-app-uploads',
	region: 'us-east-1',
})
```

Use `endpoint` and `forcePathStyle: true` for non-AWS S3-compatible providers.

## Related packages

- [`file-storage`](https://github.com/remix-run/remix/tree/main/packages/file-storage)
- [`form-data-parser`](https://github.com/remix-run/remix/tree/main/packages/form-data-parser)

## License

See [LICENSE](https://github.com/remix-run/remix/blob/main/LICENSE)

## Navigation

- [Remix package index](./index.md)
