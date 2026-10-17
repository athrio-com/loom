<div align="center">

<pre>
██╗      ██████╗  ██████╗ ███╗   ███╗
██║     ██╔═══██╗██╔═══██╗████╗ ████║
██║     ██║   ██║██║   ██║██╔████╔██║
██║     ██║   ██║██║   ██║██║╚██╔╝██║
███████╗╚██████╔╝╚██████╔╝██║ ╚═╝ ██║
╚══════╝ ╚═════╝  ╚═════╝ ╚═╝     ╚═╝
</pre>

**Literate programming framework for AI-assisted engineering.**

[![npm](https://img.shields.io/npm/v/@athrio/loom.svg?color=14b8a6&label=%40athrio%2Floom)](https://www.npmjs.com/package/@athrio/loom)
![license](https://img.shields.io/badge/license-MIT-blue.svg)
![status](https://img.shields.io/badge/status-pre--release-f59e0b.svg)
[![Telegram](https://img.shields.io/badge/Telegram-athrio-26A5E4?logo=telegram&logoColor=white)](https://t.me/athrio)

</div>

> [!NOTE]
> **Loom is a work in progress.** The parser, the tangler and the `loom`
> command-line tool work today. Until the first public release the syntax and
> the tangled output will change.

## What it is

You write one `.loom` file in which prose and code live together, in the order
that best explains the program. From that single source `loom` **tangles** the
code into real source files on disk, and serves the same file to your editor as
a live language — type-checked, navigable and highlighted, section by section.

The idea is Knuth's: a program as a work of literature, where the prose is not a
comment on the code but the code's other half. Loom is language-agnostic — a
document names its primary language, and any section may switch.

## Install

Node 20 or newer, or Bun 1.2 or newer.

```sh
npm install -g @athrio/loom
```

```sh
# scaffold a workspace
loom init

# tangle a .loom file, or a directory of them, into real source
loom tangle greeting.loom

# start the language server for any editor that speaks LSP
loom lsp --stdio
```

`loom --help` lists the rest.

## ⚖️ License

[MIT](./LICENSE). Copyright Quadrivium Academy Sihtasutus and Loom contributors. Everything in
this repository is under those terms.
