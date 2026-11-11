import { Array, Data, Match, Option, Order, pipe } from 'effect'
import type { Point, Position } from '@athrio/loom-ast/LoomNode'
import { boxOf, type LoomWeft, type PreambleWeft, type ProseWeft } from '@athrio/loom-ast/Weft'
import {
  type AnchorDelims,
  closesFence,
  type Fence,
  openingFence,
} from '@athrio/loom-ast/LoomTokens'
import {
  bookOf,
  type Catalogue,
  catalogueOf,
  cardOf,
  chapterOf,
  type ConceptRef,
  conceptAt,
  conceptMentionedAt,
  conceptNames,
  conceptPathOf,
  type CorpusEdit,
  type CorpusHover,
  type CorpusLocation,
  foldFirst,
  formLinesOf,
  isBookLoom,
  isConceptSection,
  linksOf,
  type Location,
  type LoomModule,
  type PartRef,
  referencesAt,
  resolveAnchor,
} from '@athrio/loom-ast/LoomCorpusAst'
import { type Boundaries, boundariesOf, type TropeNode } from './TropeBoundaries'
import { tropeOf, tropesOf } from './DeclaredKinds'

export type Scope = Data.TaggedEnum<{
  Corpus: {}
  Book: { readonly book: Option.Option<string> }
  Part: { readonly part: PartRef }
  Trope: { readonly trope: string }
}>

export const Scope = Data.taggedEnum<Scope>()

export const scopeKey = (scope: Scope): string =>
  Scope.$match(scope, {
    Corpus: () => 'corpus',
    Book: ({ book }) => JSON.stringify(['book', Option.getOrNull(book)]),
    Part: ({ part }) =>
      JSON.stringify([
        'part',
        Option.getOrNull(part.book),
        Option.getOrNull(Option.orElse(part.number, () => part.name)),
      ]),
    Trope: ({ trope }) => JSON.stringify(['trope', trope]),
  })

const sameScope = (one: Scope, other: Scope): boolean => scopeKey(one) === scopeKey(other)

const standingScopeOf = (catalogue: Catalogue, module: LoomModule): Scope =>
  module.doc.frontmatter === undefined
    ? Scope.Corpus()
    : Option.match(
        Option.filter(
          Option.map(chapterOf(catalogue, module.path), (chapter) => chapter.part),
          (part) => Option.isSome(part.number) || Option.isSome(part.name),
        ),
        {
          onSome: (part): Scope => Scope.Part({ part }),
          onNone: (): Scope => Scope.Book({ book: bookOf(module) }),
        },
      )

export const scopeOf = (boundaries: Boundaries, catalogue: Catalogue, module: LoomModule): Scope =>
  pipe(
    tropeOf(module),
    Option.filter((trope) => boundaries.tropes.has(trope)),
    Option.match({
      onSome: (trope): Scope => Scope.Trope({ trope }),
      onNone: () => standingScopeOf(catalogue, module),
    }),
  )

const enclosingScopeOf =
  (boundaries: Boundaries, catalogue: Catalogue) =>
  (scope: Scope): Option.Option<Scope> =>
    Scope.$match(scope, {
      Corpus: () => Option.none<Scope>(),
      Book: () => Option.some<Scope>(Scope.Corpus()),
      Part: ({ part }) => Option.some<Scope>(Scope.Book({ book: part.book })),
      Trope: ({ trope }) =>
        Option.map(Option.fromNullishOr(boundaries.tropes.get(trope)), (node): Scope =>
          Option.match(
            Option.filter(node.parent, (parent) => boundaries.tropes.has(parent)),
            {
              onSome: (parent): Scope => Scope.Trope({ trope: parent }),
              onNone: () => standingScopeOf(catalogue, node.root),
            },
          ),
        ),
    })

export const scopeChainOf = (
  boundaries: Boundaries,
  catalogue: Catalogue,
  scope: Scope,
): ReadonlyArray<Scope> => {
  const outward = enclosingScopeOf(boundaries, catalogue)
  const walk = (at: Scope, passed: ReadonlySet<string>): ReadonlyArray<Scope> =>
    passed.has(scopeKey(at))
      ? []
      : [
          at,
          ...Option.match(outward(at), {
            onNone: (): ReadonlyArray<Scope> => [],
            onSome: (next) => walk(next, new Set([...passed, scopeKey(at)])),
          }),
        ]
  return walk(scope, new Set())
}

export type Vocabularies = {
  readonly catalogue: Catalogue
  readonly boundaries: Boundaries
  readonly scopes: ReadonlyMap<Location, Scope>
  readonly vocabularies: ReadonlyMap<string, Vocabulary>
}

const conceptsIn = (
  catalogue: Catalogue,
  looms: ReadonlyArray<Location>,
): ReadonlyArray<ConceptRef> =>
  Array.filter(catalogue.concepts, (concept) => looms.includes(concept.module))

const namesConcept =
  (words: ReadonlySet<string>) =>
  (name: string): boolean =>
    words.has(foldFirst(name)) || words.has(foldFirst(name.slice(name.lastIndexOf(',') + 1).trim()))

const importsOf = (
  catalogue: Catalogue,
  named: (name: string) => boolean,
  looms: ReadonlyArray<LoomModule>,
): ReadonlyArray<ConceptRef> =>
  Array.flatMap(looms, (module) =>
    pipe(
      linksOf(module),
      Array.filter((link) => named(link.name.value)),
      Array.map((link) =>
        Option.flatMap(resolveAnchor(catalogue, module.path, link), (ref) =>
          conceptAt(catalogue, ref),
        ),
      ),
      Array.getSomes,
    ),
  )

export const vocabulariesOf = (catalogue: Catalogue, boundaries: Boundaries): Vocabularies => {
  const modules = Array.fromIterable(catalogue.modules.values())
  const scopes: ReadonlyMap<Location, Scope> = new Map(
    Array.map(modules, (module) => [module.path, scopeOf(boundaries, catalogue, module)] as const),
  )
  const outward = enclosingScopeOf(boundaries, catalogue)
  const named = namesConcept(
    new Set(
      Array.flatMap(catalogue.concepts, (concept) => Array.map(conceptNames(concept), foldFirst)),
    ),
  )
  const loomsIn = (scope: Scope): ReadonlyArray<LoomModule> =>
    Array.filter(modules, (module) =>
      Option.exists(Option.fromNullishOr(scopes.get(module.path)), (own) => sameScope(own, scope)),
    )
  const nestedIn = (scope: Scope): ReadonlyArray<TropeNode> =>
    Array.filter(Array.fromIterable(boundaries.tropes.values()), (node) =>
      Option.exists(outward(Scope.Trope({ trope: node.name })), (around) =>
        sameScope(around, scope),
      ),
    )
  const addedBy = (scope: Scope): ReadonlyArray<ConceptRef> => {
    const own = loomsIn(scope)
    return [
      ...conceptsIn(
        catalogue,
        Array.map(own, (module) => module.path),
      ),
      ...Array.flatMap(nestedIn(scope), (node) => conceptsIn(catalogue, node.entries)),
      ...importsOf(catalogue, named, own),
    ]
  }
  const standing = Array.dedupeWith(Array.fromIterable(scopes.values()), sameScope)
  const chains = Array.map(standing, (scope) => scopeChainOf(boundaries, catalogue, scope))
  const added = new Map(
    Array.map(Array.dedupeWith(Array.flatten(chains), sameScope), (scope) => [
      scopeKey(scope),
      addedBy(scope),
    ]),
  )
  return {
    catalogue,
    boundaries,
    scopes,
    vocabularies: new Map(
      Array.zipWith(standing, chains, (scope, chain) => [
        scopeKey(scope),
        vocabularyOf(
          Array.flatMap(chain, (around) =>
            Option.getOrElse(Option.fromNullishOr(added.get(scopeKey(around))), () => []),
          ),
        ),
      ]),
    ),
  }
}

export const vocabularyAt = (
  vocabularies: Vocabularies,
  path: Location,
): Option.Option<Vocabulary> =>
  Option.flatMap(Option.fromNullishOr(vocabularies.scopes.get(path)), (scope) =>
    Option.fromNullishOr(vocabularies.vocabularies.get(scopeKey(scope))),
  )

const noVocabularies = (catalogue: Catalogue): Vocabularies => ({
  catalogue,
  boundaries: { tropes: new Map(), chains: new Map(), derived: new Map() },
  scopes: new Map(),
  vocabularies: new Map(),
})

export const vocabulariesIn = (modules: ReadonlyMap<Location, LoomModule>): Vocabularies => {
  const catalogue = catalogueOf(modules)
  return Array.isReadonlyArrayNonEmpty(catalogue.concepts)
    ? vocabulariesOf(catalogue, boundariesOf(modules, catalogue, tropesOf(modules)))
    : noVocabularies(catalogue)
}

export type Vocabulary = {
  readonly concepts: ReadonlyArray<ConceptRef>
  readonly claims: ReadonlyMap<string, ReadonlyArray<ConceptRef>>
  readonly pattern: Option.Option<RegExp>
}

const sameConcept = (one: ConceptRef, other: ConceptRef): boolean =>
  one.module === other.module && one.section === other.section

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const formPattern = (form: string): string => {
  const first = form.charAt(0)
  return first.toLowerCase() === first.toUpperCase()
    ? escaped(form)
    : `[${first.toUpperCase()}${first.toLowerCase()}]${escaped(form.slice(1))}`
}

const wordPattern = (forms: ReadonlyArray<string>): Option.Option<RegExp> =>
  Option.map(
    Option.liftPredicate(forms, Array.isReadonlyArrayNonEmpty),
    (some) =>
      new RegExp(
        `(?<![\\p{L}\\p{N}_])(?:${Array.join(Array.map(some, formPattern), '|')})(?![\\p{L}\\p{N}_])`,
        'gu',
      ),
  )

const vocabularyOf = (gathered: ReadonlyArray<ConceptRef>): Vocabulary => {
  const concepts = Array.dedupeWith(gathered, sameConcept)
  const named = Array.flatMap(concepts, (concept) =>
    Array.map(Array.dedupe(Array.map(conceptNames(concept), foldFirst)), (name) => ({
      name,
      concept,
    })),
  )
  const claims: ReadonlyMap<string, ReadonlyArray<ConceptRef>> = new Map(
    Array.map(Object.entries(Array.groupBy(named, ({ name }) => name)), ([name, found]) => [
      name,
      Array.map(found, ({ concept }) => concept),
    ]),
  )
  return {
    concepts,
    claims,
    pattern: wordPattern(
      Array.sort(
        Array.fromIterable(claims.keys()),
        Order.flip(Order.mapInput(Order.Number, (form: string) => form.length)),
      ),
    ),
  }
}

type ProseLine = PreambleWeft | ProseWeft

const isProseLine = (weft: LoomWeft): weft is ProseLine =>
  weft.type === 'PreambleWeft' || weft.type === 'ProseWeft'

type Reading = { readonly quote: Option.Option<Fence>; readonly inBox: boolean }

const outside: Reading = { quote: Option.none(), inBox: false }

const readOn = (state: Reading, line: ProseLine): readonly [Reading, boolean] =>
  Option.match(state.quote, {
    onSome: (fence): readonly [Reading, boolean] => [
      closesFence(fence)(line.source) ? { ...state, quote: Option.none() } : state,
      false,
    ],
    onNone: () =>
      Option.match(boxOf(line), {
        onSome: (box): readonly [Reading, boolean] => [
          { ...state, inBox: box.side === 'open' },
          false,
        ],
        onNone: () =>
          Option.match(state.inBox ? Option.none<Fence>() : openingFence(line.source), {
            onSome: (fence): readonly [Reading, boolean] => [
              { ...state, quote: Option.some(fence) },
              false,
            ],
            onNone: (): readonly [Reading, boolean] => [state, true],
          }),
      }),
  })

const readableLines = (wefts: ReadonlyArray<LoomWeft>): ReadonlyArray<ProseLine> =>
  Array.getSomes(
    Array.mapAccum(Array.filter(wefts, isProseLine), outside, (state, line) => {
      const [next, readable] = readOn(state, line)
      return [next, readable ? Option.some(line) : Option.none<ProseLine>()]
    })[1],
  )

const literals = /`[^`]*`|\]\([^)]*\)|<[^>\s][^>]*>|https?:\/\/\S+/g

const blanked = (text: string, from: number, to: number): string =>
  text.slice(0, from) + ' '.repeat(Math.max(0, to - from)) + text.slice(to)

const scanTextOf = (line: ProseLine): string => {
  const start = line.position.start.offset
  const tokens = [...line.anchors, ...(line.type === 'PreambleWeft' ? line.warps : [])]
  return Array.reduce(
    tokens,
    line.source.replace(literals, (found) => ' '.repeat(found.length)),
    (text, token) =>
      blanked(text, token.position.start.offset - start, token.position.end.offset - start),
  )
}

export type ClaimedWord = {
  readonly word: string
  readonly position: Position
  readonly claims: ReadonlyArray<ConceptRef>
}

const wordsOn =
  (vocabulary: Vocabulary, pattern: RegExp, own: Option.Option<ConceptRef>) =>
  (line: ProseLine): ReadonlyArray<ClaimedWord> =>
    Array.getSomes(
      Array.map(Array.fromIterable(scanTextOf(line).matchAll(pattern)), (found) => {
        const claims = Option.getOrElse(
          Option.fromNullishOr(vocabulary.claims.get(foldFirst(found[0]))),
          (): ReadonlyArray<ConceptRef> => [],
        )
        const from = line.position.start.offset + found.index
        return claims.length === 0 ||
          Option.exists(own, (self) => Array.some(claims, (claim) => sameConcept(claim, self)))
          ? Option.none()
          : Option.some({
              word: found[0],
              position: {
                start: { line: line.position.start.line, offset: from },
                end: { line: line.position.start.line, offset: from + found[0].length },
              },
              claims,
            })
      }),
    )

type Passage = {
  readonly own: Option.Option<ConceptRef>
  readonly lines: ReadonlyArray<ProseLine>
}

const passagesOf = (catalogue: Catalogue, module: LoomModule): ReadonlyArray<Passage> => [
  { own: Option.none(), lines: readableLines(module.doc.preamble) },
  ...Array.map(module.doc.sections, (section): Passage => {
    const concept = isConceptSection(section)
      ? conceptAt(catalogue, { module: module.path, section })
      : Option.none()
    const listing = new Set(
      Array.map(
        Option.isSome(concept) ? formLinesOf(section) : [],
        (line) => line.position.start.offset,
      ),
    )
    return {
      own: concept,
      lines: Array.filter(
        readableLines([...section.preamble, ...section.code]),
        (line) => !listing.has(line.position.start.offset),
      ),
    }
  }),
]

export const claimedWordsIn = (
  vocabularies: Vocabularies,
  module: LoomModule,
): ReadonlyArray<ClaimedWord> =>
  pipe(
    vocabularyAt(vocabularies, module.path),
    Option.flatMap((vocabulary) =>
      Option.map(vocabulary.pattern, (pattern) => ({ vocabulary, pattern })),
    ),
    Option.match({
      onNone: (): ReadonlyArray<ClaimedWord> => [],
      onSome: ({ vocabulary, pattern }) =>
        Array.flatMap(passagesOf(vocabularies.catalogue, module), ({ own, lines }) =>
          Array.flatMap(lines, wordsOn(vocabulary, pattern, own)),
        ),
    }),
  )

export type Recognised = { readonly word: ClaimedWord; readonly concept: ConceptRef }

const recognisedOf = (word: ClaimedWord): Option.Option<Recognised> =>
  word.claims.length === 1
    ? Option.map(Array.head(word.claims), (concept) => ({ word, concept }))
    : Option.none()

export const recognisedIn = (
  vocabularies: Vocabularies,
  module: LoomModule,
): ReadonlyArray<Recognised> =>
  Array.getSomes(Array.map(claimedWordsIn(vocabularies, module), recognisedOf))

const covers = (position: Position, offset: number): boolean =>
  position.start.offset <= offset && offset <= position.end.offset

const moduleAt = (vocabularies: Vocabularies, path: Location): Option.Option<LoomModule> =>
  Option.fromNullishOr(vocabularies.catalogue.modules.get(path))

export const recognisedAt = (
  vocabularies: Vocabularies,
  path: Location,
  offset: number,
): Option.Option<Recognised> =>
  Option.flatMap(moduleAt(vocabularies, path), (module) =>
    Array.findFirst(recognisedIn(vocabularies, module), ({ word }) =>
      covers(word.position, offset),
    ),
  )

export const recognisedDefinitionAt = (
  vocabularies: Vocabularies,
  path: Location,
  offset: number,
): Option.Option<CorpusLocation> =>
  Option.map(recognisedAt(vocabularies, path, offset), ({ concept }) => ({
    path: concept.module,
    position: concept.name.position,
  }))

export const recognisedHoverAt = (
  vocabularies: Vocabularies,
  path: Location,
  offset: number,
): Option.Option<CorpusHover> =>
  Option.map(recognisedAt(vocabularies, path, offset), ({ word, concept }) => ({
    position: word.position,
    markdown: cardOf(concept),
  }))

export const recognisedRangeAt = (
  vocabularies: Vocabularies,
  path: Location,
  offset: number,
): Option.Option<CorpusLocation> =>
  Option.map(recognisedAt(vocabularies, path, offset), ({ word }) => ({
    path,
    position: word.position,
  }))

const conceptUnder = (
  vocabularies: Vocabularies,
  path: Location,
  offset: number,
): Option.Option<ConceptRef> =>
  Option.orElse(
    conceptMentionedAt(vocabularies.catalogue, vocabularies.catalogue.modules, path, offset),
    () => Option.map(recognisedAt(vocabularies, path, offset), ({ concept }) => concept),
  )

const recognisedUsesOf = (
  vocabularies: Vocabularies,
  concept: ConceptRef,
): ReadonlyArray<CorpusLocation> =>
  Array.flatMap(Array.fromIterable(vocabularies.catalogue.modules.values()), (module) =>
    pipe(
      recognisedIn(vocabularies, module),
      Array.filter((found) => sameConcept(found.concept, concept)),
      Array.map(({ word }): CorpusLocation => ({ path: module.path, position: word.position })),
    ),
  )

export const conceptReferencesAt = (
  vocabularies: Vocabularies,
  path: Location,
  offset: number,
): Option.Option<ReadonlyArray<CorpusLocation>> =>
  Option.map(conceptUnder(vocabularies, path, offset), (concept) => [
    ...referencesAt(
      { modules: vocabularies.catalogue.modules },
      concept.module,
      concept.name.position.start.offset,
    ),
    ...recognisedUsesOf(vocabularies, concept),
  ])

export type ConceptFix = {
  readonly title: string
  readonly edits: ReadonlyArray<CorpusEdit>
}

export const linksAt = (
  vocabularies: Vocabularies,
  path: Location,
  start: number,
  end: number,
  delims: AnchorDelims,
): ReadonlyArray<ConceptFix> =>
  Option.match(moduleAt(vocabularies, path), {
    onNone: (): ReadonlyArray<ConceptFix> => [],
    onSome: (module) =>
      pipe(
        claimedWordsIn(vocabularies, module),
        Array.filter(
          (found) =>
            found.claims.length > 1 &&
            found.position.start.offset <= end &&
            start <= found.position.end.offset,
        ),
        Array.flatMap((found) =>
          Array.getSomes(
            Array.map(found.claims, (concept) =>
              Option.map(
                conceptPathOf(vocabularies.catalogue, path, concept, found.word),
                (named): ConceptFix => ({
                  title: `Link to \`${named}\``,
                  edits: [
                    { path, at: found.position, text: `${delims.open}${named}${delims.close}` },
                  ],
                }),
              ),
            ),
          ),
        ),
      ),
  })

export type ConceptMove = {
  readonly concept: string
  readonly targets: Array.NonEmptyReadonlyArray<ConceptFix>
}

const opensItsScope = (module: LoomModule): boolean =>
  isBookLoom(module) || module.doc.frontmatter?.partName !== undefined

const homeOf = (vocabularies: Vocabularies, scope: Scope): Option.Option<LoomModule> =>
  scope._tag === 'Trope'
    ? Option.map(
        Option.fromNullishOr(vocabularies.boundaries.tropes.get(scope.trope)),
        (node) => node.root,
      )
    : pipe(
        Array.fromIterable(vocabularies.catalogue.modules.values()),
        Array.filter((module) =>
          Option.exists(Option.fromNullishOr(vocabularies.scopes.get(module.path)), (own) =>
            sameScope(own, scope),
          ),
        ),
        Array.sort(
          Order.combine(
            Order.mapInput(Order.Boolean, (module: LoomModule) => !opensItsScope(module)),
            Order.mapInput(Order.String, (module: LoomModule) => module.path),
          ),
        ),
        Array.head,
      )

const labelOf = (scope: Scope): string =>
  Scope.$match(scope, {
    Corpus: () => 'the corpus',
    Book: ({ book }) =>
      Option.match(book, { onNone: () => 'the book', onSome: (name) => `the book \`${name}\`` }),
    Part: ({ part }) =>
      Option.match(part.number, {
        onSome: (number) => `Part ${number}`,
        onNone: () => `the part \`${Option.getOrElse(part.name, () => '')}\``,
      }),
    Trope: ({ trope }) => `the \`${trope}\` trope`,
  })

const titlesItsLoom = (module: LoomModule, concept: ConceptRef): boolean =>
  module.doc.frontmatter?.title === undefined &&
  Option.exists(
    Array.findFirst(module.doc.sections, (section) => section.heading.title !== undefined),
    (opening) => opening === concept.section,
  )

const endOf = (text: string): Point => ({ line: text.split('\n').length, offset: text.length })

const separatorAfter = (text: string): string =>
  Match.value(text).pipe(
    Match.when(
      (held: string) => held === '' || held.endsWith('\n\n'),
      () => '',
    ),
    Match.when(
      (held: string) => held.endsWith('\n'),
      () => '\n',
    ),
    Match.orElse(() => '\n\n'),
  )

const movedTo = (
  module: LoomModule,
  concept: ConceptRef,
  home: LoomModule,
): ReadonlyArray<CorpusEdit> => {
  const start = concept.section.heading.position.start
  const end = Option.getOrElse(
    Option.map(
      Array.findFirst(
        module.doc.sections,
        (section) => section.position.start.offset > start.offset,
      ),
      (next) => next.position.start,
    ),
    () => endOf(module.text),
  )
  const at = endOf(home.text)
  return [
    { path: module.path, at: { start, end }, text: '' },
    {
      path: home.path,
      at: { start: at, end: at },
      text: `${separatorAfter(home.text)}${module.text.slice(start.offset, end.offset).trimEnd()}\n`,
    },
  ]
}

export const movesAt = (
  vocabularies: Vocabularies,
  path: Location,
  offset: number,
): ReadonlyArray<ConceptMove> =>
  Option.toArray(
    Option.flatMap(moduleAt(vocabularies, path), (module) =>
      pipe(
        Array.findFirst(
          vocabularies.catalogue.concepts,
          (concept) => concept.module === path && covers(concept.section.heading.position, offset),
        ),
        Option.filter((concept) => !titlesItsLoom(module, concept)),
        Option.flatMap((concept) =>
          pipe(
            Option.fromNullishOr(vocabularies.scopes.get(path)),
            Option.map((scope) =>
              Array.getSomes(
                Array.map(
                  Array.drop(
                    scopeChainOf(vocabularies.boundaries, vocabularies.catalogue, scope),
                    1,
                  ),
                  (target) =>
                    Option.map(homeOf(vocabularies, target), (home): ConceptFix => ({
                      title: `Move \`${concept.name.source}\` up to ${labelOf(target)}`,
                      edits: movedTo(module, concept, home),
                    })),
                ),
              ),
            ),
            Option.flatMap(
              Array.match({
                onEmpty: () => Option.none<ConceptMove>(),
                onNonEmpty: (targets) => Option.some({ concept: concept.name.source, targets }),
              }),
            ),
          ),
        ),
      ),
    ),
  )
