// PostToolUse(Read): the moment a .loom file is opened, surface the Loom prose
// standard — so its prose is written within the standard, not revised after the
// fact. Adds context only for .loom reads, and never blocks or errors a read.
let data = ''
process.stdin.on('data', (chunk) => (data += chunk))
process.stdin.on('end', () => {
  try {
    const file = JSON.parse(data || '{}')?.tool_input?.file_path ?? ''
    if (!file.endsWith('.loom')) return
    const additionalContext = [
      'You just opened a Loom file — its prose is a first-class half of the',
      'product, so write it within the prose standard, not as cleanup afterward.',
      'The rules (full text and checklist in .claude/skills/prose/SKILL.md):',
      'actor in the subject, action in the verb; old before new; no three-noun',
      'stacks; ground every abstraction; cut needless words; define what you name;',
      'prefer plain words and expand jargon. Edit prose only — never the => code —',
      'and check against the checklist before presenting.',
    ].join(' ')
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext },
      }),
    )
  } catch {
    /* never disrupt a read */
  }
})
