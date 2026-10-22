((preamble) @injection.content
  (#set! injection.language "markdown"))

((prose) @injection.content
  (#set! injection.language "markdown"))

((toc) @injection.content
  (#set! injection.language "markdown")
  (#set! injection.include-children))

(section
  (heading
    specifier: (specifier
      label: (label) @injection.language))
  (code [(code_text) @injection.content (anchor)]+)
  (#not-any-of? @injection.language "Tangle" "tangle" "TOC" "toc" "Prose" "prose"))

((section
  (heading
    specifier: (specifier
      label: (label) @_language))
  (code [(code_text) @injection.content (anchor)]+))
  (#any-of? @_language "Prose" "prose")
  (#set! injection.language "markdown"))

(section
  (heading
    !specifier
    sink: (sink
      file: (file
        extension: (extension) @injection.language)))
  (code [(code_text) @injection.content (anchor)]+))

(section
  (heading
    specifier: (specifier
      label: (label) @_tangle)
    sink: (sink
      file: (file
        extension: (extension) @injection.language)))
  (code [(code_text) @injection.content (anchor)]+)
  (#any-of? @_tangle "Tangle" "tangle"))

(document
  (frontmatter
    (field
      key: (key) @_key
      value: (value) @injection.language))
  (section
    (heading
      specifier: (specifier
        label: (label) @_tangle)
      !sink)
    (code [(code_text) @injection.content (anchor)]+))
  (#eq? @_key "Language")
  (#any-of? @_tangle "Tangle" "tangle")
  (#not-any-of? @injection.language "Prose" "prose"))

(document
  (frontmatter
    (field
      key: (key) @_key
      value: (value) @injection.language))
  (section
    (heading
      !specifier
      !sink)
    (code [(code_text) @injection.content (anchor)]+))
  (#eq? @_key "Language")
  (#not-any-of? @injection.language "Prose" "prose"))

((document
  (frontmatter
    (field
      key: (key) @_key
      value: (value) @_language))
  (section
    (heading
      !specifier
      !sink)
    (code [(code_text) @injection.content (anchor)]+)))
  (#eq? @_key "Language")
  (#any-of? @_language "Prose" "prose")
  (#set! injection.language "markdown"))

((document
  (frontmatter
    (field
      key: (key) @_key
      value: (value) @_language))
  (section
    (heading
      specifier: (specifier
        label: (label) @_tangle)
      !sink)
    (code [(code_text) @injection.content (anchor)]+)))
  (#eq? @_key "Language")
  (#any-of? @_tangle "Tangle" "tangle")
  (#any-of? @_language "Prose" "prose")
  (#set! injection.language "markdown"))
