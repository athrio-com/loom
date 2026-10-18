vim.filetype.add({ extension = { loom = 'loom' } })

vim.api.nvim_create_autocmd('User', {
  pattern = 'TSUpdate',
  callback = function()
    require('nvim-treesitter.parsers').loom = {
      install_info = {
        url = 'https://github.com/athrio-com/loom',
        location = 'packages/tree-sitter-loom',
        queries = 'packages/tree-sitter-loom/queries',
      },
    }
  end,
})

vim.api.nvim_create_autocmd('FileType', {
  pattern = 'loom',
  callback = function()
    vim.treesitter.start()
  end,
})

vim.lsp.enable('loom')
