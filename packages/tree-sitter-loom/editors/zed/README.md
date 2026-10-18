Loom for Zed and Gram
=====================

[Loom](https://github.com/athrio-com/loom) is a literate programming framework. This extension brings `.loom` files to life in Zed, and in Gram, Zed's fork without AI features or telemetry. Loom's own marks are coloured, the prose reads as Markdown, and each section's code is coloured in its own language. Loom's language server checks the looms and moves between their sections.

This repository is generated. The extension is written in the Loom book, in `corpus/09-extensions-for-ides/10-loom-in-zed-and-gram.loom`, and tangled to `packages/tree-sitter-loom/editors/zed` in the Loom repository, which this repository mirrors. Make a change there, not here.

Install
-------

Install the `loom` command first, with `npm install -g @athrio/loom` or `bun install -g @athrio/loom`. The extension starts Loom's language server with `loom lsp`.

In Gram, open the Extensions page, choose **Install From URL**, and enter `https://github.com/athrio-com/loom-zed`. Gram builds the extension and its grammar on your machine. That takes Rust installed through rustup, and the first build downloads the WebAssembly toolchain, which takes a minute.

In Zed, clone this repository, run `zed: install dev extension`, and choose the folder.

TypeScript
----------

Loom's own checks work in any loom. To check TypeScript sections too, turn TypeScript on in the project with `loom add typescript`, and give the server a TypeScript 6 to check with, `bun add -d typescript@6`. TypeScript 7 has no JavaScript API for the server to load.

Licence
-------

MIT. See [LICENSE](LICENSE).
