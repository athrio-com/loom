---
name: annotations
description: Print the Loom annotation utility's remarks into the chat and work through them. Use when the user says "check my notes", "check my annotations", "check the annotations", or otherwise refers to feedback left through the annotation overlay. Runs the `loom-annotate` command, reads the time-ordered log, and addresses each open remark in order.
---

# Reviewing Loom annotations

The annotation utility (`@athrio/loom-annotate`) captures a person's remarks on a running app — annotations pinned to an element, and free-standing messages — into `.loom/feedback.jsonl`, one per line, in the order they were made. This skill brings those remarks into the chat so you address them as a single batched review, the way you would a normal prompt.

## Print the remarks

Run the command from the project root:

```sh
bunx loom-annotate
```

In this repository you can also run it directly: `bun packages/loom-annotate/src/print.ts`. Either way it searches the workspace for every `.loom/feedback.jsonl` and prints each entry with its sequence number, status (open or resolved), kind, page route, the element an annotation points at (its label and CSS selector), and the words written.

Show the command's output in the chat so the remarks are on the record, then work from it.

## Work through the open remarks

Read top to bottom — that is the order they were made, so treat the whole list as one prompt and decide what to take now. The **open** remarks are the work; resolved ones are context. For each open remark:

1. Understand what it asks. An annotation names an element and a route — use the label and selector to find what it refers to in the running UI. A message stands on its own.
2. Act where you can. These are a review of the rendered app, so most map to a change in the `.loom` corpus that tangles it — edit the corpus and re-tangle, never the tangled output.
3. Settle it when handled — with the command, not a hand-edit of the log. Run `bunx loom-annotate resolve <seq>` to mark it addressed; a resolved remark stays in the log as a record. If the workspace has more than one log, name it: `bunx loom-annotate resolve <seq> <log-path>` (the paths are printed above each group). Discard one that no longer applies with `bunx loom-annotate discard <seq>`.

## Report

Summarise the outcome per remark — addressed, deferred, or needs clarification — and call out anything you could not resolve and why.
