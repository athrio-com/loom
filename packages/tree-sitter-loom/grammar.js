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
    $._code_fence_line,
    $._verbatim_line,
    $._box_line,
    $._box_body_line,
    $._box_close_line,
    $._divider_line,
    $.box_name,
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
        choice($.heading, $.divider),
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
    label: (_) => /[a-zA-Z0-9_-]+( [a-zA-Z0-9_-]+)*/,

    sink: ($) => seq('[', field('file', $.file), ']'),
    file: ($) => seq(optional($._file_stem), field('extension', $.extension)),
    _file_stem: (_) => /[^\]\r\n]*\./,
    extension: (_) => /[^\].\r\n]+/,

    divider: ($) => seq($._divider_line, $.divider_marker, $._newline),
    divider_marker: (_) => token(seq(/---+/, /[ \t]*/)),

    preamble: ($) =>
      repeat1(
        choice(
          seq(
            $._prose_line,
            repeat(choice($._text, $._code_span, $.anchor, $.warp)),
            $._newline,
          ),
          $._verbatim,
          $.box,
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
            $.box,
          ),
        ),
      ),

    tilde: (_) => '~',

    _prose_inline: ($) => choice($._text, $._code_span, $.anchor),

    _verbatim: ($) => seq($._verbatim_line, optional(/[^\r\n]+/), $._newline),

    code: ($) =>
      seq(
        $._arrow_line,
        optional($._space),
        $.arrow,
        repeat(choice($.code_text, $.anchor, $.code_fence)),
        optional(alias($._after_fence, $.prose)),
      ),

    arrow: (_) => '=>',

    code_fence: ($) =>
      seq(
        $._code_fence_line,
        optional($._space),
        $.fence_marker,
        optional($._space),
        optional($.fence_label),
        $._newline,
      ),

    fence_marker: (_) => /```+/,
    fence_label: (_) => /[^\s`][^\r\n]*/,

    _after_fence: ($) =>
      repeat1(
        choice(seq($._prose_line, repeat($._prose_inline), $._newline), $._verbatim, $.box),
      ),

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
        optional(field('specifier', $.anchor_specifier)),
      ),
    name: (_) => /[^\]\r\n]+/,
    target: (_) => token(prec(1, /\([^)\r\n]*\)/)),

    anchor_specifier: ($) => seq(alias($._anchor_brace, '{'), $._braced, '}'),
    _anchor_brace: (_) => token(prec(1, '{')),

    _braced: ($) =>
      choice(field('label', $.label), seq($.parameter, repeat(seq($._space, $.parameter)))),

    parameter: ($) =>
      seq(
        field('key', $.parameter_key),
        field('value', choice($.parameter_value, $.parameter_list)),
      ),
    parameter_key: (_) => /[A-Za-z_][A-Za-z0-9_-]*=/,
    parameter_value: (_) => choice(/"([^"\\\r\n]|\\.)*"/, /[A-Za-z0-9_.-]+/),
    parameter_list: ($) =>
      seq(
        '[',
        optional($._space),
        $.parameter_value,
        repeat(seq(optional($._space), ',', optional($._space), $.parameter_value)),
        optional($._space),
        ']',
      ),

    box: ($) =>
      seq(
        $._box_line,
        optional($._space),
        $.box_fence,
        optional(field('name', $.box_name)),
        optional($._space),
        optional(seq(field('specifier', $.box_specifier), optional($._space))),
        $._newline,
        optional($.box_body),
        optional($._box_close),
      ),

    box_fence: (_) => ':::',

    box_specifier: ($) => seq('{', $._braced, '}'),

    box_body: ($) => repeat1(seq($._box_body_line, repeat($._prose_inline), $._newline)),

    _box_close: ($) =>
      seq($._box_close_line, optional($._space), $.box_fence, optional($._space), $._newline),

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
