use zed_extension_api::{self as zed, LanguageServerId, Result};

struct LoomExtension;

impl zed::Extension for LoomExtension {
    fn new() -> Self {
        LoomExtension
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let loom = worktree.which("loom").ok_or_else(|| {
            "Loom's language server comes with the loom command, which is not on your PATH. \
             Install it with `npm install -g @athrio/loom`."
                .to_string()
        })?;
        Ok(zed::Command {
            command: loom,
            args: vec!["lsp".into(), "--stdio".into()],
            env: worktree.shell_env(),
        })
    }
}

zed::register_extension!(LoomExtension);
