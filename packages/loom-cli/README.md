# @athrio/loom-cli

The command-line interface for [Loom](https://github.com/athrio-com/loom), a
literate-programming framework built on Effect-TS. A `.loom` document weaves
prose and code in narrative order; `loom tangle` composes the code sections into
real source files on disk.

## Install

```sh
npm install -g @athrio/loom-cli
```

## Usage

```sh
loom tangle path/to/doc.loom   # tangle one document
loom tangle path/to/dir        # tangle every .loom under a directory, recursively
```

A document declares its outputs with `{path}` section specifiers. `loom tangle`
builds the corpus reachable from each document, resolves the anchors and Warps
across files, and writes every `{path}` target relative to the document that
declares it.

## License

Apache-2.0 OR MIT
