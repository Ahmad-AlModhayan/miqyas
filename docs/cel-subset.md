# The CEL subset

The claims of Miqyas are data, and their rules are CEL expressions ([ADR 0011](adr/0011-claims-are-data-in-cel.md),
[FOUNDATION §4](FOUNDATION.md)). A rule is loaded once, under static limits, and then evaluated over facts to `true`,
`false` or `error` (the type `Truth` in the code; a verdict is something else, the judge's record for a whole claim).
This page says which part of CEL a rule may use, what the limits are, how the work a rule can do is bounded, what
`normalize()` does, and shows one rule for each of the five places a claim holds one: `where`, `holds`, `usable`,
`count` and `covered`.

The interface is `compile` and `evaluate` in `src/kernel/cel.ts`. The CEL library behind it is recorded in
[the library note](research/cel-library-2026-11.md); the subset is checked by the kernel itself when an expression is
loaded, so it does not change with the library.

## What an expression may use

**Values.** Whole numbers (CEL `int`, 64 bits), text, `true` and `false`, `null`, lists, and maps with text keys.
Facts are JSON data, so these are all a fact can hold. A variable that holds a fraction, NaN, infinity, a whole
number a JSON number cannot hold exactly, or anything that is not plain data makes the evaluation `error`; it is never
rounded or guessed at.

**Operators.** `+ - * / %` on integers (overflow is an error), `+` on text and on lists, `== != < <= > >=`,
`&& || !`, `?:`, `in` (a list or a map), `[ ]` on lists and maps, and `.` for a field. How errors pass through `&&`,
`||` and the macros, and why `==` across types is not an error, is under "Errors are never true or false".

**Functions.** `size(x)`, `has(x.field)`, `int(x)`, `string(x)`, `matches(text, pattern)` and `normalize(text)`.

**Methods.** `.size()`, `.contains(text)`, `.startsWith(text)`, `.endsWith(text)`, `.matches(pattern)`.

**Macros.** `list.all(v, test)`, `list.exists(v, test)`, `list.exists_one(v, test)`, `list.map(v, expr)` and
`list.filter(v, test)`; `map` may also take a filter as its second argument. The form with two variables is not
allowed.

**Patterns.** `matches` takes RE2 syntax, so a pattern cannot be made to run for a long time. There are no lookahead,
lookbehind or back-references. The pattern must be a literal text in the expression, such as `'^[a-z]+$'`, so that
its work is known when the rule is loaded; a pattern read from a variable is outside the subset.

A missing field or key is an error, not `null`. Use `has(item.field)` to test whether a field is there.

## What it may not use

- Fractions and exponents (`1.5`, `1e3`), unsigned integers (`1u`), bytes (`b"..."`), and so the conversions to them.
- Timestamps, durations and any clock: there is no `now`, and no function reads the time.
- Protobuf messages, message construction (`Name{...}`), enums, and optional syntax (`.?`, `[?`).
- Comments, and backtick-quoted names. Write `item["odd-name"]`, not a backtick name.
- Functions and methods not listed above (`type`, `dyn`, `timestamp`, `getFullYear` and the rest).
- A comprehension with two variables.
- A `matches` pattern that is not a literal text.

An expression that uses any of these is refused when it is loaded, with the reason `subset` and a message that names
what was found. An expression that is not CEL at all is refused with the reason `syntax`.

## The limits

No clock is involved. Some limits are checked on the expression when it is loaded, others on the variables when they
are handed in.

| Limit | Default | Checked | What it bounds |
|---|---|---|---|
| `maxLength` | 1024 | when loaded | characters in the expression |
| `maxDepth` | 16 | when loaded | nesting of parentheses, brackets and braces |
| `maxComprehensionDepth` | 2 | when loaded | macros (`all`, `exists`, `map` and the rest) inside one another |
| `maxListLength` | 1000 | both | elements in a list or map literal, and in any list or map in the variables |
| `maxStringLength` | 1000 | with the variables | characters (UTF-16 code units) in any text or map key in the variables |
| `maxInputSize` | 10000 | with the variables | the size of all the variables together (below) |
| `maxCost` | 40000000 | when loaded | the work the expression may do, in steps, over the largest variables the limits allow |

An expression over a limit is refused when it is loaded, with the reason `limit`, and the message names the limit,
for example `the expression is 1500 characters, over the limit maxLength of 1024`. Variables over an input limit make
the evaluation `error`. A caller may pass lower or higher limits to `compile`; a limit must be a whole number of 0 or
more. The same expression over the same variables always gives the same answer.

**Size.** Each integer, boolean, null, list and map counts 1, and each text (a map key too) counts 1 plus its length.
`[1, 2, 3]` has size 4, `"abcd"` size 5 and `{"a": 1}` size 4.

## The cost bound

Terminating is not the same as cheap ([ADR 0011](adr/0011-claims-are-data-in-cel.md)), so when an expression is
loaded the kernel computes the most work it can do over any variables within the input limits, and refuses it when
that is over `maxCost`. The computation reads the parsed expression (the standard CEL syntax tree) and needs no types:
a value read from a variable is taken at its largest, a list of `maxListLength` elements, a text of `maxStringLength`
characters and a size of `maxInputSize`. The code is `src/kernel/cel-cost.ts`.

**What counts as a walk.** A walk is any operation whose work grows with the size of a value. In the subset:

| Operation | Work counted |
|---|---|
| `all`, `exists`, `exists_one`, `map`, `filter` | the body once for each element of the list or map, plus one step per element and per join |
| `in` | the size of the list or map searched, and the length of the text looked up |
| `==`, `!=`, `<`, `<=`, `>`, `>=` | the size of the smaller operand, times its joins (lists and maps compare element by element) |
| `+` | the length of each text joined; joining integers or lists is one step |
| `size`, `int`, `string` | the length of the text read |
| `contains`, `startsWith`, `endsWith` | (length of the text + 1) times (length of the text searched for + 1) |
| `matches` | (length of the text + 1) times the pattern's program: its length + 1, times each counted repetition `{m,n}` + 1 |
| `normalize` | the length of the text, and the text it gives is taken as 324 times as long (NFKD can make one code unit 18, and it runs twice) |
| `[ ]` | one step per join of the list, and the length of a text key |
| list and map literals | one step per element, and the length of each key |

Every other node of the expression costs one step. A length is the smaller of the longest text the value can hold and
its size. The library joins lists lazily: a list built by `map` or `filter` holds one join per element, and one built
by `+` one more than its parts, and reading an element walks those joins. The bound counts them.

**Over a comprehension.** The work of the body is added up over the elements it walks. The elements of a list
together are no larger than the list, so a walk of the comprehension's own variable (comparing it, reading its length)
adds up to the size of the list, not to the number of elements times the largest element. A walk of anything else is
counted again for each element.

**The worst case.** With `L` = `maxListLength`, `S` = `maxStringLength`, `U` = `maxInputSize`, `n` the number of nodes
in the expression (a few for each of its at most `maxLength` characters) and `d` how deep its comprehensions nest (at
most `maxComprehensionDepth`), the work is at most about `n · L^d · W`, where `W` is the largest single walk: up to
`U` for a comparison or `in` over the variables, `S · S` for a text search, and `325 · S` for `normalize`. A walk of a
comprehension's own variable adds up to `U` over its elements, which takes one `L` off for that walk. Whatever the
expression, it loads only if the computed work is at most `maxCost`, so no expression that loads can take more than
`maxCost` steps.

At the defaults, the costliest rules found that still load took under 0.4 seconds on the machine the defaults were
set on, over variables at the largest the input limits allow. The costliest compares every pair from two lists of
1000 three-element lists, twice (34 million steps); `test/unit/kernel-cel-limits.test.ts` runs it at full size:

```cel
expected.exists(e, observed.exists(o, o == e || e == o))
```

A two-level rule that compares scalars, such as `expected.all(e, observed.exists(o, o.id == e.id))`, loads (22 million
steps). A rule that walks a whole variable inside two comprehensions, as `x.all(a, x.all(b, b in x))` does, is refused
when it is loaded (11 billion steps).

## Errors are never true or false

`evaluate` returns `error` when anything goes wrong: a missing field, an operator applied to a type it does not take
(`1 + 'a'`, `1 < 'a'`), an overflow, a division by zero, a variable that is not CEL data, a variable over an input
limit, or a result that is not a boolean. Nothing but a result that is exactly `true` or `false` gives either of those.
The judge reads `error` as uncertain ([FOUNDATION §4](FOUNDATION.md), "The judge").

**Equality across types is not an error.** CEL defines `==` and `!=` for any two values, and Miqyas keeps that so a
rule means the same in every CEL implementation: `'a' == 1` is `false` and `'a' != 1` is `true`. `in` is built on
`==`, so `1 in ['a']` is `false`. Where a reader might expect `error`, `==`, `!=` and `in` across types give `true` or
`false`. The `usable` example below gives `false`, not `error`, when `owner_status` arrives as the text `"200"`, and
`item.other_status != 401` is `true` when `other_status` is the text `"401"`. Ordering across types (`<`, `<=`, `>`,
`>=`) is an error.

**Errors that are absorbed.** `false && error` is `false` and `true || error` is `true`, because the error cannot
change the answer; `error && true` and `error || false` are `error`. The macros follow the same rule:

- `all` is `false` when the test is `false` for some element, even if it is an error for another; otherwise an error
  for any element makes it `error`. `['a', 0].all(a, a > 0)` is `false`; `['a', 1].all(a, a > 0)` is `error`.
- `exists` is `true` when the test is `true` for some element, even if it is an error for another; otherwise an error
  for any element makes it `error`. `['a', 1].exists(a, a > 0)` is `true`; `['a', 0].exists(a, a > 0)` is `error`.
- `exists_one`, `map` and `filter` are `error` when the test or the expression is an error for any element.

In every other case an error stays an error.

## normalize()

`normalize(text)` makes text comparable. It is a pure function of its argument and gives the same result wherever
claims are evaluated. The shared test vectors are in `test/vectors/normalize.json`. In order:

1. Unicode form NFKC.
2. Remove invisible format characters: zero-width and direction marks, the byte order mark, the soft hyphen.
3. Remove Arabic tatweel, the vowel and other marks (U+064B to U+065F), the superscript alef and the Quranic annotation
   marks.
4. Fold letter variants: alef with madda, hamza or wasla to alef; alef maqsura and Persian yeh to yeh; teh marbuta to
   heh; Persian kaf to kaf.
5. Lower case, by the Unicode default mapping and not by locale.
6. NFKC again, so the result is stable.
7. Every run of white space becomes one space, and the ends are trimmed.

What it does not fold: hamza on waw and on yeh, and the Arabic-Indic and Persian digits (NFKC leaves them as they
are). Two texts that differ only in those are different texts.

## One rule for each place

The facts and variables in these examples are made up to show the form. Each expression is run by
`test/unit/kernel-cel.test.ts`, and that test also checks that it appears here word for word.

An expression sees one `item`, one pair or one event; the engine does the quantifying
([FOUNDATION §4](FOUNDATION.md)).

**`where`** picks the items that are inside the claim. Over `item`:

```cel
item.role == "button" && !item.hidden
```

**`holds`** is the rule the chosen items must meet. Over `item`:

```cel
item.name.size() > 0 && !normalize(item.name).contains("click here")
```

**`usable`** says when a measurement can be used at all; an item for which it is not `true` is uncertain. Over `item`:

```cel
item.owner_status == 200 && item.other_status != 401
```

**`count`** is the rule for a `count` claim. It gives a yes or no for each count the judge tries. Over `n`, the
number of items inside the claim:

```cel
n >= 1 && n <= 3
```

**`covered`** says when the enumeration counts as complete. Over `ctx`. The shape of `ctx` is defined by the claim
loader, not by this page; this example only shows a rule over it:

```cel
ctx.pages.size() > 0 && ctx.inputs.accounts.size() >= 2
```
