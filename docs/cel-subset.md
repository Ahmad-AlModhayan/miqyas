# The CEL subset

The claims of Miqyas are data, and their rules are CEL expressions ([ADR 0011](adr/0011-claims-are-data-in-cel.md),
[FOUNDATION §4](FOUNDATION.md)). A rule is loaded once, under static limits, and then evaluated over facts to `true`,
`false` or `error`. This page says which part of CEL a rule may use, what the limits are, what `normalize()` does,
and shows one rule for each of the five places a claim holds one: `where`, `holds`, `usable`, `count` and `covered`.

The interface is `compile` and `evaluate` in `src/kernel/cel.ts`. The CEL library behind it is recorded in
[the library note](research/cel-library-2026-11.md); the subset is checked by the kernel itself when an expression is
loaded, so it does not change with the library.

## What an expression may use

**Values.** Whole numbers (CEL `int`, 64 bits), text, `true` and `false`, `null`, lists, and maps with text keys.
Facts are JSON data, so these are all a fact can hold. A variable that holds a fraction, NaN, infinity, a whole
number a JSON number cannot hold exactly, or anything that is not plain data makes the evaluation `error`; it is never
rounded or guessed at.

**Operators.** `+ - * / %` on integers (overflow is an error), `+` on text and on lists, `== != < <= > >=`,
`&& || !`, `?:`, `in` (a list or a map), `[ ]` on lists and maps, and `.` for a field. `&&` and `||` follow the CEL
rule for errors: `false && error` is `false` and `true || error` is `true`, because the error cannot change the
answer; in every other case an error stays an error.

**Functions.** `size(x)`, `has(x.field)`, `int(x)`, `string(x)`, `matches(text, pattern)` and `normalize(text)`.

**Methods.** `.size()`, `.contains(text)`, `.startsWith(text)`, `.endsWith(text)`, `.matches(pattern)`.

**Macros.** `list.all(v, test)`, `list.exists(v, test)`, `list.exists_one(v, test)`, `list.map(v, expr)` and
`list.filter(v, test)`; `map` may also take a filter as its second argument. The form with two variables is not
allowed.

**Patterns.** `matches` takes RE2 syntax, so a pattern cannot be made to run for a long time. There are no lookahead,
lookbehind or back-references.

A missing field or key is an error, not `null`. Use `has(item.field)` to test whether a field is there.

## What it may not use

- Fractions and exponents (`1.5`, `1e3`), unsigned integers (`1u`), bytes (`b"..."`), and so the conversions to them.
- Timestamps, durations and any clock: there is no `now`, and no function reads the time.
- Protobuf messages, message construction (`Name{...}`), enums, and optional syntax (`.?`, `[?`).
- Comments, and backtick-quoted names. Write `item["odd-name"]`, not a backtick name.
- Functions and methods not listed above (`type`, `dyn`, `timestamp`, `getFullYear` and the rest).
- A comprehension with two variables.

An expression that uses any of these is refused when it is loaded, with the reason `subset` and a message that names
what was found. An expression that is not CEL at all is refused with the reason `syntax`.

## The limits

Checked on the text when the expression is loaded. No clock is involved.

| Limit | Default | What it bounds |
|---|---|---|
| `maxLength` | 1024 | characters in the expression |
| `maxDepth` | 16 | nesting of parentheses, brackets and braces |
| `maxComprehensionDepth` | 2 | macros (`all`, `exists`, `map` and the rest) inside one another |
| `maxListLength` | 1000 | elements in a list or map literal, and the most a list or map variable may hold when evaluated |

An expression over a limit is refused with the reason `limit`, and the message names the limit, for example
`the expression is 1500 characters, over the limit maxLength of 1024`. A caller may pass lower or higher limits to
`compile`; a limit must be a whole number of 0 or more.

Because the text and the size of the lists are bounded, the work an expression can do is bounded, and the same
expression over the same variables always gives the same answer.

## Errors are never true or false

`evaluate` returns `error` when anything goes wrong: a missing field, a type mismatch, an overflow, a division by zero,
a variable that is not CEL data, a list longer than `maxListLength`, or a result that is not a boolean. Nothing but a
result that is exactly `true` or `false` gives either of those. The judge reads `error` as uncertain
([FOUNDATION §4](FOUNDATION.md), "The judge").

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

**`count`** is the rule for a `count` claim. Over `n`, the number of items inside the claim:

```cel
n >= 1 && n <= 3
```

**`covered`** says when the enumeration counts as complete. Over `ctx`. The shape of `ctx` is defined by the claim
loader, not by this page; this example only shows a rule over it:

```cel
ctx.pages.size() > 0 && ctx.inputs.accounts.size() >= 2
```
