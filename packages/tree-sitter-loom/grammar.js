/**
 * @file The Loom literate programming format
 * @license MIT
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

const anchorOpen = '::' + '['

module.exports = grammar({
  name: 'loom',

  extras: (_) => [],

  externals: ($) => [
    $._fence_line,
    $._field_line,
    $._heading_line,
    $._arrow_line,
    $._tilde_line,
    $._prose_line,
    $._code_line,
    $._toc_line,
    $._verbatim_line,
    $._note_line,
    $._note_body_line,
    $._newline,
    $._error_sentinel,
  ],

  rules: {
    document: ($) =>
      seq(optional($.frontmatter), optional($.preamble), repeat($.section)),

    frontmatter: ($) =>
      seq(
        $._fence_line,
        $.frontmatter_fence,
        $._newline,
        repeat(seq($._field_line, optional($.field), $._newline)),
        optional(seq($._fence_line, $.frontmatter_fence, $._newline)),
      ),

    frontmatter_fence: (_) => token(seq('---', /[ \t]*/)),

    field: ($) =>
      seq(
        field('key', $.key),
        optional(seq(':', optional($._space), optional(field('value', $.value)))),
      ),

    key: (_) => /[^:\r\n]+/,
    value: (_) => /[^ \t\r\n]([^\r\n]*[^ \t\r\n])?/,
    _space: (_) => /[ \t]+/,

    section: ($) =>
      seq(
        $.heading,
        optional($.toc),
        optional($.preamble),
        repeat(choice($.code, $.prose)),
      ),

    heading: ($) =>
      seq(
        $._heading_line,
        $.heading_marker,
        optional(field('title', $.title)),
        optional($._space),
        repeat(
          seq(
            choice(field('specifier', $.specifier), field('sink', $.sink)),
            optional($._heading_rest),
          ),
        ),
        $._newline,
      ),

    heading_marker: (_) => /#{1,6} /,
    title: (_) => /[^{\[\r\n]*[^{\[\s]/,
    _heading_rest: (_) => /[^{\[\r\n]+/,

    specifier: ($) => seq('{', field('label', $.label), '}'),
    label: (_) => /[a-zA-Z0-9_-]+/,

    sink: ($) => seq('[', field('file', $.file), ']'),
    file: ($) => seq(optional($._file_stem), field('extension', $.extension)),
    _file_stem: (_) => /[^\]\r\n]*\./,
    extension: (_) => /[^\].\r\n]+/,

    toc: ($) =>
      repeat1(
        seq(
          $._toc_line,
          optional(choice($.toc_part, $.toc_chapter, $._toc_text)),
          $._newline,
        ),
      ),

    toc_part: ($) =>
      seq(alias($._toc_part_marker, $.heading_marker), alias($._toc_text, $.title)),
    toc_chapter: ($) =>
      seq(alias($._toc_number, $.number), alias($._toc_text, $.title)),
    _toc_part_marker: (_) => token(prec(1, /#{1,6}[ \t]+/)),
    _toc_number: (_) => token(prec(1, /[ \t]*\d+\.[ \t]+/)),
    _toc_text: (_) => /[^\r\n]+/,

    preamble: ($) =>
      repeat1(
        choice(
          seq(
            $._prose_line,
            repeat(choice($._text, $._code_span, $.anchor, $.warp)),
            $._newline,
          ),
          $._verbatim,
          $.note,
        ),
      ),

    prose: ($) =>
      seq(
        $._tilde_line,
        $.tilde,
        repeat($._prose_inline),
        $._newline,
        repeat(
          choice(
            seq($._prose_line, repeat($._prose_inline), $._newline),
            $._verbatim,
            $.note,
          ),
        ),
      ),

    tilde: (_) => '~',

    _prose_inline: ($) => choice($._text, $._code_span, $.anchor),

    _verbatim: ($) => seq($._verbatim_line, optional(/[^\r\n]+/), $._newline),

    note: ($) =>
      seq(
        $._note_line,
        optional($._space),
        $.note_marker,
        optional(/[^\r\n]+/),
        $._newline,
        repeat(seq($._note_body_line, optional(/[^\r\n]+/), $._newline)),
      ),

    note_marker: (_) => ':' + anchorOpen + 'Note]',

    code: ($) =>
      seq($._arrow_line, optional($._space), $.arrow, repeat(choice($.code_text, $.anchor))),

    arrow: (_) => choice('=>', '~>'),

    code_text: ($) => prec.right(repeat1(choice($._code_run, $._newline, $._code_line))),

    _text: (_) => choice(/[^`:{\r\n]+/, /:/, /\{/),
    _code_span: (_) => choice(/`[^`\r\n]*`/, /`/),
    _code_run: (_) => choice(/[^:\r\n]+/, /:/),

    anchor: ($) =>
      seq(
        alias(anchorOpen, $.anchor_open),
        field('name', $.name),
        ']',
        optional(field('target', $.target)),
      ),
    name: (_) => /[^\]\r\n]+/,
    target: (_) => token(prec(1, /\([^)\r\n]*\)/)),

    warp: ($) =>
      seq(
        '{{',
        optional($._space),
        field('name', $.identifier),
        optional($._space),
        optional(seq(':', field('annotation', $.annotation))),
        optional(seq('=', field('default', $.default))),
        '}}',
      ),
    identifier: (_) => /[a-zA-Z_][a-zA-Z0-9_]*/,
    annotation: (_) => /[^=}\r\n]+/,
    default: (_) => /([^}\r\n]|\}[^}\r\n])+/,
  },
})
