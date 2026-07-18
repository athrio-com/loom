---
name: notes
description: Check the Loom MCP for notes left on a running app and work through them, or subscribe to be notified as new ones land. Use when the user says "check my notes", "check notes", "check the annotations", "review notes", "watch for notes", "subscribe to notes", or otherwise refers to feedback left through the Loom Notes overlay. Reads open notes per project over the Loom MCP tools and addresses each in order; for an ongoing watch, arms a Monitor on the daemon's live feed instead of polling.
---

# Reviewing Loom Notes

A reviewer points at a running app through the Loom Notes overlay and leaves notes on it — a chat note typed into the panel, a DOM annotation pinned to an element, or a Loom annotation pinned to a fragment woven from a `.loom` source. The notes land in the Loom Notes daemon's store, and a coding agent reads them over the **Loom MCP**. This skill brings the open notes into the chat so you address them as one batched review, the way you would a normal prompt.

## Read the notes over the MCP

The notes daemon serves the MCP at `http://localhost:5710/mcp`; a `.mcp.json` registers it, so the tools are available as MCP tools in this session. The MCP is never scoped to one project — it sees every project the store holds. A project's identifier only says where a note came from and where it renders; it never narrows what you can read. A workspace is often a monorepo with several projects, or none yet, so do not assume there is only one.

1. Call **`projects`** to see every project the store holds — each with its id and the name to show it by.
2. Call **`notes`** with a project's id — for each of them, or the one the user names — to get its open, unaddressed notes, in the order they were made. Sweep them all: a note may have landed under any project, and the point is to catch whatever is new.

Show what you find in the chat so the notes are on the record, then work from it.

If the tools are not available, the daemon is not running or the MCP is not connected. Say so rather than guessing, and point to the fix: start it with `loom start` (default port `5710`), and make sure the project's `.mcp.json` carries `{ "type": "http", "url": "http://localhost:5710/mcp" }`.

## Subscribing for notes as they land

Reading the store once catches whatever is already there. When the user asks you to keep watching — or wraps this skill in `/loop` — the daemon can push new notes to you instead, so you are not stuck asking again on a timer.

The daemon exposes `GET /notes/live?project=<id>`, upgraded to a WebSocket: hold it open and it writes each new note for that project as one JSON frame, the instant the note is recorded. Build the URL from the same host and port `.mcp.json` names for the MCP endpoint — swap `http` for `ws` and `/mcp` for `/notes/live` — since a project may run the daemon on a port other than the default `5710`.

Arm a persistent Monitor on it, one per project you are watching:

    Monitor({
      ws: { url: "ws://localhost:5710/notes/live?project=<id>" },
      persistent: true,
      description: "New Loom notes on <id>",
    })

Each frame is one note, in the same shape a single entry from `notes` takes. Treat it exactly like a note found in the batch read below — understand it, act where you can, then `resolve` or `discard` it. The channel carries only what is published after you subscribe, so still call `notes` once at the start to pick up anything that landed first.

## Work through the open notes

Read top to bottom — that is the order they were made, so treat the whole list as one prompt and decide what to take now.

For each open note:

1. **Understand what it asks.** A chat note stands on its own. A DOM annotation names an element by its label and CSS selector, on a route — use those to find what it points at in the running UI. A Loom annotation names a fragment woven from a `.loom` source — find that source in the corpus.
2. **Act where you can.** These review the rendered app, so most map to a change in the `.loom` corpus that tangles it — edit the corpus and re-tangle, never the tangled output.
3. **Settle it with the tools.** Call **`resolve`** with the project and sequence once you have addressed it; a resolved note stays in the store as a record. Call **`discard`** with the project and sequence for one that no longer applies.

## Report

Summarise the outcome per note — addressed, deferred, or needs clarification — and call out anything you could not resolve and why.
