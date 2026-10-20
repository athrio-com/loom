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
  root_dir = function(bufnr, on_dir)
    local workspace = function(name, path)
      local config = vim.fs.joinpath(path, name, 'config.yaml')
      return name == '.loom' and vim.uv.fs_stat(config) ~= nil
    end
    on_dir(vim.fs.root(bufnr, workspace) or vim.fs.root(bufnr, '.git'))
  end,
}
