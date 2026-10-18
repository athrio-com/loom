(frontmatter_fence) @punctuation.special

(field
  ":" @punctuation.delimiter)

((field
  key: (key) @_key
  value: (value) @markup.heading)
  (#match? @_key "^Part"))

((field
  key: (key) @_key
  value: (value) @markup.heading)
  (#match? @_key "^Chapter"))

((field
  key: (key) @_key
  value: (value) @string.special.path)
  (#eq? @_key "Package"))

((field
  key: (key) @_key
  value: (value) @type)
  (#eq? @_key "Language"))

((field
  key: (key) @_key
  value: (value) @string)
  (#not-match? @_key "^Part")
  (#not-match? @_key "^Chapter")
  (#not-eq? @_key "Package")
  (#not-eq? @_key "Language"))

(field
  key: (key) @variable.other.member)

((heading
  (heading_marker) @_marker) @markup.heading.1
  (#eq? @_marker "# "))

((heading
  (heading_marker) @_marker) @markup.heading.2
  (#eq? @_marker "## "))

((heading
  (heading_marker) @_marker) @markup.heading.3
  (#eq? @_marker "### "))

((heading
  (heading_marker) @_marker) @markup.heading.4
  (#eq? @_marker "#### "))

((heading
  (heading_marker) @_marker) @markup.heading.5
  (#eq? @_marker "##### "))

((heading
  (heading_marker) @_marker) @markup.heading.6
  (#eq? @_marker "###### "))

(specifier
  [
    "{"
    "}"
  ] @punctuation.bracket)

(specifier
  label: (label) @type)

((specifier
  label: (label) @keyword.directive)
  (#any-of? @keyword.directive "Tangle" "tangle" "TOC" "toc"))

(sink
  [
    "["
    "]"
  ] @punctuation.bracket)

(sink
  file: (file) @string.special.path)

(arrow) @operator

(tilde) @operator

(anchor
  (anchor_open) @punctuation.special
  "]" @punctuation.special)

(anchor
  name: (name) @label)

(anchor
  target: (target) @string.special.path)

(warp
  [
    "{{"
    "}}"
  ] @punctuation.special)

(warp
  name: (identifier) @variable)

(warp
  ":" @punctuation.delimiter)

(warp
  annotation: (annotation) @type)

(warp
  "=" @operator)

(warp
  default: (default) @string)

(note) @comment

(note_marker) @comment.note
