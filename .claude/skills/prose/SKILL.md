---
name: prose
description: Loom's prose standard — the rules, checklist, and worked examples for clear, literate prose. Write within it when authoring or refining any .loom prose or documentation, and check against its checklist before presenting.
---

# Loom prose — the standard

In Loom, prose is not commentary on the code — it is the conceptual product layer a
person reads. The prose stands with the code as an equal — two halves of one
product, not source wrapped in documentation. This skill is the standard that prose
must meet: rules, a checklist, and worked examples. It governs every `.loom` in the
repository, and any documentation written alongside them.

The premise is Knuth's: "let us concentrate … on explaining to human beings what we
want a computer to do," treating a program as "a work of literature" (Knuth, 1984).
Every rule below serves one test — a reader moves through the prose without
stumbling and finishes knowing what the thing is and why it exists.

## Prose defines the code

A loom alternates prose and code: a preamble, then `=>` and its code, then `~` and
more prose, then `=>` again. The prose defines the code, but freely: at each step
it may state what the code does, explain it, or amend its meaning, in whatever form
fits. The code follows from the prose, not the prose from the code; this is the
literate order.

Write prose with the categories that define a thing in mind: **what** it is,
**why** it exists, **how** it works, and — in the code — **what** it becomes. Each
answers a question worth holding as you write. Hold them loosely, though: one lead
is a bare definition, the next carries all three, each at its own level. It is a
habit of thought, not a template — keep it implicit, and let the prose read as
prose.

## The rules

**1. Put the actor in the subject and the action in the verb.** A clear sentence
names a character and says what it does. Choose every *is*, *are*, and *has* carefully —
they often hide the real verb inside a noun. "The intention of the committee is to
improve morale" buries the action; "the committee intends to improve morale" states
it. Use *is* only for a true identity — where one thing genuinely is the other
(Williams, *Style*).

**2. Old before new.** Open each sentence with something the reader already knows,
and end it on the new point you want to land. A stumble is usually a sentence that
opens on the unfamiliar, or one that trails off after its point instead of ending
on it (Gopen & Swan, 1990).

**3. Unstack the nouns.** Never pile three nouns where a verb or a preposition would
untangle them. "A build-time service registry config file" makes the reader work
out the relationships; "the registry of services available at build time" states
them (Knuth, Larrabee & Roberts, *Mathematical Writing*).

**4. Ground every abstraction.** Give an abstract noun a concrete the reader can
picture — not "editor support" but "editor support: its diagnostics, hover, and
completion."

**5. Omit needless words.** Cut every word that does not change the meaning
(Strunk & White).

**6. Define what you name.** Define each thing the first time you name it, and state
anything important twice — once precisely, once in plain words. A reader who misses
a definition cannot follow what builds on it (Knuth, Larrabee & Roberts,
*Mathematical Writing*).

**7. Prefer natural language.** Reach for a plain word before a technical one, and
expand every abbreviation, term of art, or symbol the first time it appears (Knuth,
Larrabee & Roberts, *Mathematical Writing*).

## The checklist

Run this over each paragraph before it is shown:

- Every *is / are / has*: a true identity, or a verb in hiding?
- Any run of three or more nouns? Break it with a verb or a preposition.
- Does each abstraction name a concrete?
- Is each thing defined where it's first named — anything important, twice?
- Any abbreviation, jargon term, or symbol used before it's expanded?
- Does the sentence open on the familiar and end on its point?
- One idea per sentence?
- Read it aloud — any stumble or re-read? Rewrite until there is none.

## Examples

Each pair is a real correction, with the fault named.

*A true `is`, not a false one (rule 1).*
- ✗ Every language's editor support is a `LoomService`.
- ✓ A `LoomService` *is* the contract each Loom language service implements.

*Noun stack (rule 3).*
- ✗ a build-time service registry config file
- ✓ the registry of services available at build time

*Buried lede, interrupting aside (rule 2).*
- ✗ `@athrio/loom-config` is the model of a project's `loom.config.json` — the
  languages it has activated — and the service that reads and writes it.
- ✓ A project records its activated languages in `loom.config.json`.
  `@athrio/loom-config` defines that file's shape and reads and writes it.

*Cleverness over plainness (rule 4).*
- ✗ Starting the runtime, the filesystem is the end of the world.
- ✓ Running the program starts the runtime — where the effects run and the files
  reach disk.

*False scope (precision).*
- ✗ Most languages need no package.
- ✓ The languages Volar already supports are written here as TS modules; every other
  language ships as a package.

## How to apply

Write within these rules as you author a loom's prose — they shape the draft, not
just its cleanup. Before presenting anything, run the checklist over it sentence by
sentence and show the revised draft, never the first. When the prose lives in a
loom, change the prose only — never the `=>` code chunks — then re-tangle through
the built `loom` CLI and confirm the output is byte-identical: the revision changed
the prose, not the code.

A hook surfaces this skill the moment you open a `.loom`, so the standard is in
front of you as you write; invoke `/prose` to run the pass on demand.

## Sources

- Joseph M. Williams, *Style: Lessons in Clarity and Grace*.
- George D. Gopen & Judith A. Swan, "The Science of Scientific Writing," *American
  Scientist* 78 (1990).
- Donald E. Knuth, "Literate Programming," *The Computer Journal* 27(2) (1984).
- Donald E. Knuth, Tracy Larrabee & Paul M. Roberts, *Mathematical Writing*, MAA
  Notes 14 (1989).
- William Strunk Jr. & E. B. White, *The Elements of Style*.
