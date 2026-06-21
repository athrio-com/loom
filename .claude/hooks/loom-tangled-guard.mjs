// PreToolUse(Edit|Write): block hand-edits of tangled output. A package with a
// corpus/ authors its .ts from .loom files, so editing the tangled artifact is a
// mistake. Deny, and point back to the corpus. Left alone: a package without a
// corpus/ (the hand-written bootstrap, e.g. loom-lang), and any test/ or scripts/
// file (hand-written dev probes and harnesses, never a tangle target).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
let data = ''
process.stdin.on('data', (c) => (data += c))
process.stdin.on('end', () => {
  try {
    const file = JSON.parse(data || '{}')?.tool_input?.file_path ?? ''
    if (!/\.(ts|tsx)$/.test(file)) return
    if (/\/(node_modules|dist|out|test|scripts)\//.test(file)) return
    const pkg = file.match(/^(.*\/packages\/[^/]+)\//)?.[1]
    if (!pkg || file.startsWith(pkg + '/corpus/') || !existsSync(join(pkg, 'corpus')))
      return
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `${file} is tangled output. ${pkg}/corpus authors it from .loom — edit the ` +
            '.loom section whose {path} targets this file and re-tangle with the published ' +
            'loom CLI. Never edit the artifact.',
        },
      }),
    )
  } catch {
    /* never block on error */
  }
})
