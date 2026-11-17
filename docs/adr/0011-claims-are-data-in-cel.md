# Claims are data, written in CEL

A claim's rules (which items it covers, what must hold for each, what coverage it needs) are data, written in the
Common Expression Language (CEL), and not code. CEL has no side effects and is specified to terminate, is defined
independently of any one implementation, and has implementations in TypeScript and Rust. The engine does the
quantifying (every item, some item, no item, a count) and evaluates one small expression per item, so the pass rules of
ADR 0006 can't be bypassed from inside an expression.

Rules have to be data for three reasons. A model can propose a claim without anything it wrote being run as code (ADR
0009). A company can add its own checks and profiles as files. And a bundle can carry the exact rule that judged it, so
a second verifier, in another language, reaches the same verdict (ADR 0007).

## Considered options

- A rule format of our own in JSON: rejected. We would be designing and maintaining a language, and every verifier
  would need its own interpreter for it.
- Rego: rejected. It is heavier than the job needs, and its official WebAssembly build for JavaScript has gone a long
  time without a release.
- JSONata or jq: rejected. Both allow recursion, so an expression isn't guaranteed to terminate.
- Cedar: rejected. It is shaped for authorisation decisions, not for rules over arbitrary sets of facts.
- TypeScript functions: rejected. They aren't portable to another verifier, and they aren't safe to accept from a
  model or from a file a user hands in.

## Consequences

- Only a documented subset of CEL is allowed. Terminating isn't the same as cheap, so the cost of an expression is
  bounded when a claim is loaded, from its size, its nesting and the largest list it may walk. No clock takes part in
  judging, which keeps a verdict a function of the facts.
- An error is never read as true or false. CEL's own rule stands inside an expression: an error is absorbed only when
  the other operand already decides the result. An error that reaches the top makes that item uncertain, and a claim
  can't pass over an uncertain item.
- Fact schemas use integers and strings and no floating-point numbers, so two implementations can't disagree on a
  value. Text is compared through one documented `normalize()` function, with shared test vectors.
- The TypeScript implementations differ in maturity. The library sits behind one small interface, is chosen by running
  the language's conformance suite in CI, and its version is recorded in every bundle. Swapping it must not change a
  verdict.
- Logic too rich for a rule lives in derivations and checkers (ADR 0006), and a claim names the ones it relies on.
