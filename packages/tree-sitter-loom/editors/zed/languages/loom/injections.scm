((preamble) @injection.content
  (#set! injection.language "markdown"))

((prose) @injection.content
  (#set! injection.language "markdown"))

(section
  (heading
    specifier: (specifier
      label: (label) @injection.language))
  (code [(code_text) @injection.content (anchor)]+)
  (#not-any-of? @injection.language "Tangle" "tangle" "Prose" "prose"))

(section
  (heading
    specifier: (specifier
      (parameter
        key: (parameter_key) @_key
        value: (parameter_value) @injection.language)))
  (code [(code_text) @injection.content (anchor)]+)
  (#eq? @_key "lang=")
  (#not-any-of? @injection.language "Prose" "prose"))

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

(section
  (heading
    specifier: (specifier
      .
      (parameter
        key: (parameter_key) @_key
        value: (parameter_value) @_tangle)
      .)
    sink: (sink
      file: (file
        extension: (extension) @injection.language)))
  (code [(code_text) @injection.content (anchor)]+)
  (#eq? @_key "kind=")
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
      specifier: (specifier
        .
        (parameter
          key: (parameter_key) @_kind
          value: (parameter_value) @_tangle)
        .)
      !sink)
    (code [(code_text) @injection.content (anchor)]+))
  (#eq? @_key "Language")
  (#eq? @_kind "kind=")
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
