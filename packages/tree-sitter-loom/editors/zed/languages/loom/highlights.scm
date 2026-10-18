(frontmatter_fence) @punctuation.special

(field
  key: (key) @property)

(field
  ":" @punctuation.delimiter)

((field
  key: (key) @_key
  value: (value) @title)
  (#match? @_key "^Part"))

((field
  key: (key) @_key
  value: (value) @title)
  (#match? @_key "^Chapter"))

((field
  key: (key) @_key
  value: (value) @link_uri)
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

(heading) @title

(specifier
  [
    "{"
    "}"
  ] @punctuation.bracket)

((specifier
  label: (label) @type)
  (#not-any-of? @type "Tangle" "tangle" "TOC" "toc"))

((specifier
  label: (label) @keyword)
  (#any-of? @keyword "Tangle" "tangle" "TOC" "toc"))

(sink
  [
    "["
    "]"
  ] @punctuation.bracket)

(sink
  file: (file) @link_uri)

(arrow) @operator

(tilde) @operator

(anchor
  (anchor_open) @punctuation.special
  "]" @punctuation.special)

(anchor
  name: (name) @label)

(anchor
  target: (target) @link_uri)

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

(note_marker) @comment.doc
