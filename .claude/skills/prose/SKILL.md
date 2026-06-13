---
name: prose
description: Loom's prose standard — the rule, its sections, and worked examples for clear, literate prose. Write within it when authoring or refining any .loom prose or documentation, and check against its questions before presenting.
---

# Loom prose — the standard

In Loom, prose and code are equal layers of one product — two halves, not source wrapped in documentation. Prose is the layer a person reads to understand what the program does and why. This skill states the standard that prose must meet. Each section states one rule and closes with questions to check your work. It governs every `.loom` file in the repository, and any documentation written alongside those files.

The premise is Knuth's: "let us concentrate … on explaining to human beings what we want a computer to do," treating a program as "a work of literature" (Knuth, 1984).

**Write for a reader so that they move through the prose without stumbling and finish knowing what the thing is and why it exists.** Every section below states a rule that serves this principle.

Write within these rules as you author a loom's prose. Every rule applies — do not follow some and skip others. Read each section body in full: the body is the rule. The heading names it; the closing question checks it. Neither replaces the body. Before presenting anything, run the questions at the close of each section over your draft sentence by sentence. Run the checklist first, then present.

Do not edit prose by patching. When a passage needs work, rewrite the whole passage from the concept, not the words on the page. Patching a clause here and a word there leaves the seams of the original showing and produces prose that reads as edited, not written. Read the passage, understand what it must convey, then write it again whole. Only then compare against the original and the rules.

A hook surfaces this skill the moment you open a `.loom` file. Invoke the `/prose` command to run the pass on demand.

Write each paragraph as a single line. Do not insert line breaks to wrap text — the editor handles wrapping. One paragraph, one line.

## Prose defines the code

A loom section that contains code opens with a preamble. The preamble defines the concept the code implements — it is the specification. Preambles may continue the narrative freely but must contain the main concept being implemented.

After the first code block, prose and code alternate freely: the `=>` operator opens a code block, the `~` separator closes it and returns to prose. Prose that follows a code block may clarify or amend the meaning of that code. Neither layer is a sub-type of the other, but the prose is never subordinate.

A loom must deliver a narrative. The reader moves through it top to bottom, and that reading order is fixed. Code chunks may appear in any order that serves the narrative. Tangle assembles them correctly regardless. The prose runs one way, from first word to last.

Prose is the specification; code is its implementation. Any developer should read the prose alone and come away understanding the program being written. Compressed or cryptic prose fails that test.

Write prose with the categories that define a thing in mind: **what** it is, **why** it exists, **how** it works, and what it becomes in the code. Each answers a question worth holding as you write. Hold them loosely: one lead is a bare definition, the next carries all three, each at its own level. Keep it as a habit of thought, not a template.

> Could a developer read the prose alone and understand the program being written?

## A loom is literature

Like a book or an article, a loom may span many domains, and the author chooses how to cut it: by category, by concept, however it reads best. Loom imposes no shape; the literate experience stays the author's.

Loom is written for people who value prose and care about the experience of reading code. Accuracy and concision are the floor, not the ceiling. Above them, prose can have rhythm, voice, and wit. A well-written loom rewards attention and is interesting to read. Aim for that.

That freedom is over structure, not over discipline. However a loom is scoped, its prose must earn its place:

- **No housekeeping.** Do not narrate the loom's own structure — which files tangle produces, where chunks land, how refs compose. The path specifiers and `=>` blocks already show that. Prose that restates what the structure makes plain is noise.
- **No water.** Prose says what the code does and why — that is its work. Water is the irrelevant aside, or the babysitting that spells out the obvious. Cut it.

> Does each sentence earn its place, or does it narrate assembly or restate the obvious?

## Section headings carry the narrative

A section heading is the first thing a reader sees. It sets the register for what follows and keeps their attention moving forward. A heading that merely names a technical unit — "Imports", "Handler", "Config" — does the minimum. A heading that signals what the section does, or why it matters, does more.

Be creative. A heading can carry tone, hint at what's coming, or make the reader smile. The loom is literature; its headings can read like chapter titles, not like identifiers. "The entry point" is better than "Main". Humour and even emojis are welcome when they fit the tone of the loom.

The constraint is honesty: a heading must still describe what follows. Wit that misleads is worse than a flat label.

> Does the heading carry the narrative, or does it just name a technical unit?

## Prose must reflect the code exactly

Style serves the reader. It does not license inaccuracy. A sentence that reads well but misrepresents what the code does is a defect, not a refinement.

When writing or editing prose about existing code, consult the actual codebase. Do not rely on memory, assumption, or what the code was supposed to do. Names, signatures, behaviour, and constraints must match what is actually implemented. If the prose and the code disagree, one of them is wrong — find out which before publishing either.

> Does the prose reflect what the code actually does? Was the codebase consulted before writing or editing this passage?

## Prose is declarative

Write in the present tense. Prose states the intended design as fact — not what the system will do, not what it used to do, but what it does. This is the declarative mode: the prose is the specification, and a specification describes its subject as it is meant to be.

Do not hedge into the future ("this will allow") or reach into the past ("this was designed to"). Both pull the reader out of the design and into its history or roadmap. State the design. Let the implementation catch up.

When prose describes a design not yet implemented, consider marking it — a note, a status, a clear boundary — then write the design itself declaratively within that boundary.

> Is the prose written in the present tense? Does it state the design as fact rather than intention or history?

## One idea at a time

Cutting water is only half the craft. The other half is giving each idea room to land.

The unit of one idea is the paragraph. The sentences within it build, support, or turn that idea. The paragraph holds exactly one. When a new idea begins, a new paragraph begins.

Within the paragraph, each sentence carries one clause. A sentence that welds three ideas with stacked dashes and colons forces the reader to pry them apart before the prose means anything — avoid this.

Concision is not compression. To omit a needless word is to cut an irrelevant aside. It is not to collapse two sentences into one until the prose reads as airless. Use a full stop where a colon is tempting. Vary sentence length so the reader has somewhere to rest. A short sentence after a long one lands. A run of welded clauses lands nothing.

> Does each paragraph hold one idea? Does each sentence carry one clause? Could a colon or dash be a full stop?

## Put the actor in the subject and the action in the verb

A clear sentence names who acts and says what they do. The subject is the actor; the verb is the act. When a sentence opens on an abstract noun instead — *the intention of*, *the function of*, *the purpose of* — the real actor is buried inside it and the real action hides in a noun.

The fix is usually simple: find the actor, make it the subject, and turn the noun back into a verb. "The intention of the committee is to improve morale" buries both; "the committee intends to improve morale" states both.

*is*, *are*, and *has* often hide a verb that should be doing the work. Use *is* only for a true identity, where one thing genuinely is the other, not merely resembles or implements it (Williams, *Style*).

*The fault and its fix.*
- ✗ Every language's editor support is a `LanguageService` interface.
- ✓ The `LanguageService` interface is the contract each Loom language service implements.

The first sentence uses *is* to say that support *takes the form of* a service: a relationship, not an identity. The correction states what the `LanguageService` interface actually is.

> Who acts in this sentence? Is the actor the subject and the action the verb?

## Open on the familiar, end on the new

A reader builds their model of a text sentence by sentence. When a sentence introduces something new, it should open with something the reader already holds and close on the new point.

A sentence that trails off after its point buries what matters. The new information should land at the end of the sentence, not get buried under qualifications that follow it (Gopen & Swan, 1990).

*The fault and its fix.*
- ✗ The `@athrio/loom-config` package is the model of a project's `loom.config.json` — the languages it has activated — and the service that reads and writes it.
- ✓ CLI records the project's activated languages in `loom.config.json`. The `@athrio/loom-config` package defines the configuration file's shape and reads and writes it.

The correction splits one overloaded sentence into two. The first lands the concept; the second names the package and its role. Each ends on its point.

> Does the sentence open on the familiar and end on its point?

## Unstack the nouns

A noun stack is three or more nouns in sequence, each modifying the next. The reader must reconstruct the relationships between those nouns before the sentence means anything. That work belongs to the prose, not the reader.

Break a stack with a verb or a preposition. State the relationship the stack implies. The result is longer by a word or two and immediately clear (Knuth, Larrabee & Roberts, *Mathematical Writing*).

*The fault and its fix.*
- ✗ a build-time service registry config file
- ✓ the registry of services available at build time

The stack hides three relationships: the registry holds services, the services are available at build time, and the registry lives in a config file. The correction states the first two directly; context handles the third.

> Any run of three or more nouns? Break it with a verb or a preposition.

## Ground every abstraction

An abstract noun — *support*, *behavior*, *integration*, *state* — names a category. A reader can follow it only if they can picture something inside that category. When you use one, give a concrete alongside it: an example, an instance, a list of the things it covers.

*The fault and its fix.*
- ✗ The compiler performs transformation.
- ✓ The compiler parses source files and emits JavaScript.

"Performs transformation" names a category. "Parses source files and emits JavaScript" names two things the compiler actually does.

> Does each abstraction name a concrete?

## State the scope of every claim

A claim that feels precise but covers the wrong set is false scope. State exactly which things you mean: not "most languages", but the exact criterion; not "here", but the exact location.

*The fault and its fix.*
- ✗ Most languages need no package.
- ✓ The languages Volar already supports are written here as TypeScript modules. Every other language ships as a package.

"Most" is imprecise. The correction names the exact criterion, Volar support, and states both cases.

> Is the scope of every claim stated exactly?

## Name the referent of every relational term

A relational term points to something it relates to. "At the end" requires "of what"; "most" requires "of which set". Never leave a relational term without its referent; the reader should not have to supply it.

*The fault and its fix.*
- ✗ The new information should land at the end.
- ✓ The new information should land at the end of the sentence.

"At the end" implies a referent the reader has to supply. The correction names it.

> Does every relational term name its referent?

## Omit needless words

Every word that does not change the meaning costs the reader attention and returns nothing. Cut it (Strunk & White).

Needless words come in several forms: the redundant pair (*each and every*, *true and accurate*), the throat-clearing opener (*it is worth noting that*, *as we can see*), the padding that restates what the structure already shows.

*The fault and its fix.*
- ✗ This loom packages the `@athrio/loom-language-services` package, apart from the looms that define its modules so the code stays separate from the way it ships. Tangling it writes two files: the manifest, `package.json`, and the TypeScript config, `tsconfig.json`.
- ✓ The `@athrio/loom-language-services` package ships as source, with no separate build step.

> Does each sentence change the reader's understanding, or does it restate what the code, a heading, or a path already shows?

## Define what you name

Define each term the first time you use it. A reader who misses a definition cannot follow anything built on it. The first occurrence is the only safe place; a definition that comes later arrives after the reader has already been lost (Knuth, Larrabee & Roberts, *Mathematical Writing*).

Once named, keep using the name. Do not substitute a pronoun or shorthand where the full term is still needed. Write "the configuration file's shape", not "that file's shape". The reader should never have to resolve what "it" or "that" refers to.

State anything important twice: once precisely, in technical terms with the definition exact, and once in plain language. A reader who misread the first pass has a second chance to land it (Knuth, Larrabee & Roberts, *Mathematical Writing*).

> Is each term defined where it first appears? Is anything important stated twice — once precisely, once plainly? Are named things referred to by their name, not by a pronoun or shorthand?

## Prefer natural language

Reach for a plain word before a technical one. A technical term earns its place when it names something a plain word cannot: when precision or brevity genuinely requires it. Otherwise the plain word is clearer to more readers at no cost.

Expand every abbreviation, term of art, and symbol the first time it appears, even when the expansion feels obvious to you. It is not obvious to every reader, and the expansion costs one line (Knuth, Larrabee & Roberts, *Mathematical Writing*).

Give every backticked identifier an article and a noun. Write "the `=>` operator", "a `.loom` file", "the `LanguageService` interface" — not bare symbols dropped into a sentence. A naked identifier is code; a named one is prose.

> Is each abbreviation, jargon term, or symbol expanded on first use? Could a plain word replace the technical one here? Does every backticked identifier have an article and a noun?

---

## Sources

- Joseph M. Williams, *Style: Lessons in Clarity and Grace*.
- George D. Gopen & Judith A. Swan, "The Science of Scientific Writing," *American Scientist* 78 (1990).
- Donald E. Knuth, "Literate Programming," *The Computer Journal* 27(2) (1984).
- Donald E. Knuth, Tracy Larrabee & Paul M. Roberts, *Mathematical Writing*, MAA Notes 14 (1989).
- William Strunk Jr. & E. B. White, *The Elements of Style*.
