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
  (code) @injection.content
  (#not-eq? @injection.language "Tangle")
  (#not-eq? @injection.language "tangle")
  (#not-eq? @injection.language "Prose")
  (#not-eq? @injection.language "prose"))

(section
  (heading
    !specifier
    sink: (sink
      file: (file) @injection.filename))
  (code) @injection.content)

(section
  (heading
    specifier: (specifier
      label: (label) @_tangle)
    sink: (sink
      file: (file) @injection.filename))
  (code) @injection.content
  (#any-of? @_tangle "Tangle" "tangle"))

(document
  (frontmatter
    (field
      key: (key) @_key
      value: (value) @injection.filename))
  (section
    (heading
      specifier: (specifier
        label: (label) @_tangle)
      !sink)
    (code) @injection.content)
  (#eq? @_key "Package")
  (#any-of? @_tangle "Tangle" "tangle"))

(document
  (frontmatter
    (field
      key: (key) @_key
      value: (value) @injection.language))
  (section
    (heading
      !specifier
      !sink)
    (code) @injection.content)
  (#eq? @_key "Language")
  (#not-eq? @injection.language "Prose")
  (#not-eq? @injection.language "prose"))

((section
  (heading
    specifier: (specifier
      label: (label) @_language))
  (code) @injection.content)
  (#any-of? @_language "Prose" "prose")
  (#set! injection.language "markdown"))

((document
  (frontmatter
    (field
      key: (key) @_key
      value: (value) @_language))
  (section
    (heading
      !specifier
      !sink)
    (code) @injection.content))
  (#eq? @_key "Language")
  (#any-of? @_language "Prose" "prose")
  (#set! injection.language "markdown"))
