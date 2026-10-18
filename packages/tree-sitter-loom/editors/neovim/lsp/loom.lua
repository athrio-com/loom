---@brief
---
--- https://github.com/athrio-com/loom
---
--- The Loom language server, which the `loom` command line ships:
---
--- ```sh
--- npm install -g @athrio/loom
--- ```
---
--- `loom lsp` finds TypeScript in the project, or beside Loom, to check
--- TypeScript sections against.

---@type vim.lsp.Config
return {
  cmd = { 'loom', 'lsp', '--stdio' },
  filetypes = { 'loom' },
  root_markers = { '.loom', '.git' },
}
