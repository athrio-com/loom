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
  (#not-match? @injection.language "^(Tangle|tangle|TOC|toc|Prose|prose)$")
  (#not-match? @injection.language "^(TypeScript|JavaScript|JSON|YAML|TOML|Markdown|CSS|HTML|Dockerfile|Rust|Python|Go|Lua|C|Bash)$"))

((section
  (heading
    specifier: (specifier
      label: (label) @_language))
  (code [(code_text) @injection.content (anchor)]+))
  (#eq? @_language "TypeScript")
  (#set! injection.language "typescript"))

((section
  (heading
    specifier: (specifier
      label: (label) @_language))
  (code [(code_text) @injection.content (anchor)]+))
  (#eq? @_language "JavaScript")
  (#set! injection.language "javascript"))

((section
  (heading
    specifier: (specifier
      label: (label) @_language))
  (code [(code_text) @injection.content (anchor)]+))
  (#eq? @_language "JSON")
  (#set! injection.language "json"))

((section
  (heading
    specifier: (specifier
      label: (label) @_language))
  (code [(code_text) @injection.content (anchor)]+))
  (#eq? @_language "YAML")
  (#set! injection.language "yaml"))

((section
  (heading
    specifier: (specifier
      label: (label) @_language))
  (code [(code_text) @injection.content (anchor)]+))
  (#eq? @_language "TOML")
  (#set! injection.language "toml"))

((section
  (heading
    specifier: (specifier
      label: (label) @_language))
  (code [(code_text) @injection.content (anchor)]+))
  (#eq? @_language "Markdown")
  (#set! injection.language "markdown"))

((section
  (heading
    specifier: (specifier
      label: (label) @_language))
  (code [(code_text) @injection.content (anchor)]+))
  (#eq? @_language "CSS")
  (#set! injection.language "css"))

((section
  (heading
    specifier: (specifier
      label: (label) @_language))
  (code [(code_text) @injection.content (anchor)]+))
  (#eq? @_language "HTML")
  (#set! injection.language "html"))

((section
  (heading
    specifier: (specifier
      label: (label) @_language))
  (code [(code_text) @injection.content (anchor)]+))
  (#eq? @_language "Dockerfile")
  (#set! injection.language "dockerfile"))

((section
  (heading
    specifier: (specifier
      label: (label) @_language))
  (code [(code_text) @injection.content (anchor)]+))
  (#eq? @_language "Rust")
  (#set! injection.language "rust"))

((section
  (heading
    specifier: (specifier
      label: (label) @_language))
  (code [(code_text) @injection.content (anchor)]+))
  (#eq? @_language "Python")
  (#set! injection.language "python"))

((section
  (heading
    specifier: (specifier
      label: (label) @_language))
  (code [(code_text) @injection.content (anchor)]+))
  (#eq? @_language "Go")
  (#set! injection.language "go"))

((section
  (heading
    specifier: (specifier
      label: (label) @_language))
  (code [(code_text) @injection.content (anchor)]+))
  (#eq? @_language "Lua")
  (#set! injection.language "lua"))

((section
  (heading
    specifier: (specifier
      label: (label) @_language))
  (code [(code_text) @injection.content (anchor)]+))
  (#eq? @_language "C")
  (#set! injection.language "c"))

((section
  (heading
    specifier: (specifier
      label: (label) @_language))
  (code [(code_text) @injection.content (anchor)]+))
  (#eq? @_language "Bash")
  (#set! injection.language "bash"))

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
  (#not-match? @injection.language "^(Prose|prose)$")
  (#not-match? @injection.language "^(TypeScript|JavaScript|JSON|YAML|TOML|Markdown|CSS|HTML|Dockerfile|Rust|Python|Go|Lua|C|Bash)$"))

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
  (#eq? @_language "TypeScript")
  (#set! injection.language "typescript"))

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
  (#eq? @_language "JavaScript")
  (#set! injection.language "javascript"))

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
  (#eq? @_language "JSON")
  (#set! injection.language "json"))

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
  (#eq? @_language "YAML")
  (#set! injection.language "yaml"))

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
  (#eq? @_language "TOML")
  (#set! injection.language "toml"))

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
  (#eq? @_language "Markdown")
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
    (code [(code_text) @injection.content (anchor)]+)))
  (#eq? @_key "Language")
  (#eq? @_language "CSS")
  (#set! injection.language "css"))

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
  (#eq? @_language "HTML")
  (#set! injection.language "html"))

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
  (#eq? @_language "Dockerfile")
  (#set! injection.language "dockerfile"))

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
  (#eq? @_language "Rust")
  (#set! injection.language "rust"))

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
  (#eq? @_language "Python")
  (#set! injection.language "python"))

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
  (#eq? @_language "Go")
  (#set! injection.language "go"))

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
  (#eq? @_language "Lua")
  (#set! injection.language "lua"))

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
  (#eq? @_language "C")
  (#set! injection.language "c"))

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
  (#eq? @_language "Bash")
  (#set! injection.language "bash"))

(section
  (heading
    !specifier
    sink: (sink
      file: (file) @injection.filename))
  (code [(code_text) @injection.content (anchor)]+))

(section
  (heading
    specifier: (specifier
      label: (label) @_tangle)
    sink: (sink
      file: (file) @injection.filename))
  (code [(code_text) @injection.content (anchor)]+)
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
    (code [(code_text) @injection.content (anchor)]+))
  (#eq? @_key "Package")
  (#any-of? @_tangle "Tangle" "tangle"))

((section
  (heading
    specifier: (specifier
      label: (label) @_language))
  (code [(code_text) @injection.content (anchor)]+))
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
    (code [(code_text) @injection.content (anchor)]+)))
  (#eq? @_key "Language")
  (#any-of? @_language "Prose" "prose")
  (#set! injection.language "markdown"))
