# Sharp text-only guard

Tracebook uses Transformers.js only for text embeddings and text reranking. Its
Node entry point nevertheless imports Sharp unconditionally, which otherwise
installs the native Sharp/libvips image stack and loads it whenever Transformers.js
is imported.

The root Yarn resolution substitutes this deliberately small CommonJS module for
the exact Sharp dependency range requested by Transformers.js. It has the export
shape Transformers.js expects, allowing all text pipelines to keep using native
`onnxruntime-node`. If Tracebook ever begins exercising an image pipeline, the
guard throws an explicit error instead of silently supplying incomplete image
behavior.

Keep the resolution descriptor and this package version aligned with the
dependency declared by `@huggingface/transformers`. The dependency contract test
will fail if the real Sharp package is restored or a different implementation is
resolved.
