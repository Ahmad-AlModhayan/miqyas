# Miqyas algorithms

Every function and formula the [foundation](FOUNDATION.md) names, numbered so that a ticket, a test or a report can
point at one. Each entry says what it is for, what it computes, what it guarantees and what it costs. Where an entry
rests on published work it names it; the checked statements and their limits are in
[research/algorithms-2026-11.md](research/algorithms-2026-11.md).

| Part | What it covers |
|---|---|
| [A. Judging](#a-judging) | from a claim and facts to a verdict: the four shapes, the fold, what the judge guarantees |
| [B. The gate](#b-the-gate) | classing a request and an origin, deciding, rate and stop |
| [C. The target model](#c-the-target-model) | states, routes, refinement, the difference between two releases |
| [D. Search](#d-search) | how counterexamples are looked for in each space, and when to stop |
| [E. The run engine](#e-the-run-engine) | the six stages of a run |
| [F. Oracles](#f-oracles) | what decides something is wrong when nobody wrote an assertion |
| [G. Assurance](#g-assurance) | coverage, confidence, sensitivity, the record per claim |
| [H. Diagnosis](#h-diagnosis) | the smallest failing case, the culprit change, the suspect code, flakiness |
| [I. Economy](#i-economy) | caching, re-running only what a change calls for, ordering |
| [K. The record](#k-the-record) | the tree over the ledger and its proofs |
| [L. Experiments](#l-experiments) | two runs from one state that differ in one thing; the laws for each axis; the matrix |
| [M. Capsules and state](#m-capsules-and-state) | restorable state, checking it is the same, what an action changed, reaching states |
| [N. Where to look first, and measuring](#n-where-to-look-first-and-how-the-engine-is-measured) | the order of testing, peers as a map, how the engine is scored |

Parts L to N specify the [experiment engine](ENGINE.md).

Notation. A verdict is one of three values: **T** (pass), **F** (fail), **U** (not known; one of `not_checked`,
`blocked`, `unverified`, with a reason). Evaluating an expression on an item gives true, false or **error**. `V` is a
view: the closed set of facts a claim is judged over.

---

## A. Judging

### A1. A `set` claim

**For**: most readiness checks and state assertions.

```
judgeSet(claim, V):
  yes = no = outside = uncertain = 0
  for x in items(V, claim.from, claim.each):
    w = eval(claim.where, x)                      # no `where` means true
    if w is false:  outside += 1;   continue
    if w is error:  uncertain += 1; continue
    if eval(claim.usable, x) is not true:         # no `usable` means true
      uncertain += 1; continue                    # the measurement can't be used
    if claim.quantifier == count:  yes += 1; continue
    h = eval(claim.holds, x)
    if h is true: yes += 1   elif h is false: no += 1   else: uncertain += 1
  covered = (eval(claim.covered, ctx(V)) is true)          # an error is not covered

  every:  no > 0        -> F
          uncertain > 0 -> U(uncertain items)
          not covered   -> U(coverage not met)
          yes == 0      -> empty(claim)
          else          -> T
  some:   yes > 0       -> T
          uncertain > 0 -> U(uncertain items)
          not covered   -> U(coverage not met)
          else          -> F
  none:   yes > 0       -> F
          uncertain > 0 -> U(uncertain items)
          not covered   -> U(coverage not met)
          no == 0       -> empty(claim)
          else          -> T
  count:  not covered   -> U(coverage not met)
          R = { eval(claim.count, n) : yes <= n <= yes + uncertain }
          R == {true} -> T;  R == {false} -> F;  else -> U(uncertain items)

empty(claim) = T marked vacuous   if claim.vacuous == 'pass'
               U(nothing to check) otherwise
```

`U(uncertain items)` carries which it was: an expression gave an error, or `usable` said a measurement can't be used.

**Guarantees**: A6. **Cost**: one pass over the items, O(|V|).

### A2. A `pair` claim

**For**: statements about two runs or two users: one account reading another's records, a route with and without a
session, an old build against a new one, a mock against the real thing, a layout before and after a flip.

```
judgePair(claim, V):
  L = select(V, claim.left);  R = select(V, claim.right)
  index = group R by keyRight(b)                 # a key that errors makes that item uncertain
  for a in L:
    P = index[keyLeft(a)]
    if P is empty: unmatched += 1; continue
    for b in P: uncertain if eval(claim.usable, a, b) is not true;
                else classify eval(claim.holds, a, b) as yes / no / uncertain
  then the table of A1 over the pairs, where
    claim.unmatched == 'uncovered' -> covered also needs unmatched == 0     (the default)
    claim.unmatched == 'fail'      -> each unmatched a counts as a counterexample
    claim.unmatched == 'ignore'    -> unmatched items are left out
```

A pair claim is the smallest form of a property over two executions. A statement such as "what account B receives
doesn't depend on what account A owns" can't be decided by looking at any single run; it needs both.

**Cost**: O(|L| + |R| + pairs), by hashing the keys.

### A3. A `trace` claim

**For**: plan assertions, and anything about order or time within one session.

Events `e1 … em` are the facts of one session in order, each with a time in whole milliseconds from the worker's
clock. `complete` means the session's collection finished; otherwise the recording may have been cut. `p`, `s`, `q`,
`r` are expressions over one event. An event on which an expression errors is uncertain: it can't support a pass.

| Pattern | `F` as soon as | `T` when | otherwise |
|---|---|---|---|
| absence(p) | some event satisfies p | none does, complete, covered | U |
| universality(p) | some event doesn't satisfy p | all do, complete, covered | U |
| existence(p) | no event satisfies p, complete, covered | some event satisfies p | U |
| precedence(s before p) | a p occurs with no earlier s | no such p, complete, covered | U |
| response(p then s within Δ) | a p is followed by no s within Δ, and the recording runs past that deadline or is complete | every p was answered in time, covered | U: a p is still open and the recording was cut before its deadline |

`during` restricts the pattern to a stretch of the session: `globally`; `before` the first event satisfying `r`;
`after` the first satisfying `q`; `between` each `q` and the next `r`. A pattern that was never triggered (no `p` for
response or precedence, no events at all) is empty and treated as in A1.

A plan assertion is a trace claim whose events are the snapshots of its window (FOUNDATION §8). "Is there" is
existence. "Isn't there" is absence, covered only when the window ended settled and no snapshot was truncated.

The three values on a finite recording follow the standard reading of temporal properties in runtime verification:
true when every continuation satisfies the property, false when none does, and inconclusive otherwise. The bound `Δ`
is what makes "eventually" decidable on a recording that ends.

**Cost**: one pass, O(m × obligations open at once).

### A4. A `sample` claim

**For**: latency, stability, and the pass rate of behaviour that isn't deterministic.

`n` measurements, of which `k` are successes; the claim is that the true proportion of successes is at least `q`, at
confidence `1 − α`. A quantile claim ("the 95th percentile is at most L") is the same test with success meaning
`x ≤ L` and `q = 0.95`.

```
judgeSample(n, k, q, α):
  if  P[ Bin(n, q) >= k ]  <= α :  T     # were the rate only q, k or more successes would be this unlikely
  if  P[ Bin(n, q) <= k ]  <= α :  F     # were the rate as high as q, k or fewer would be this unlikely
  else:                             U(too few samples)

  P[ Bin(n, q) >= k ] = Σ i=k..n  C(n,i) · q^i · (1−q)^(n−i)
```

This is the exact (Clopper-Pearson) one-sided test. With no failures at all (`k = n`) it reduces to `q^n ≤ α`:

```
samplesNeeded(q, α) = ceil( ln α / ln q )

  q = 0.90 -> 29      q = 0.95 -> 59      q = 0.99 -> 299      q = 0.999 -> 2995        (α = 0.05)
```

and the reverse reading, after `n` runs with no failure, is an upper bound on the failure rate of
`1 − α^(1/n) ≈ 3/n` at 95%.

- The test assumes the measurements are independent and come from one unchanging system. A claim says how its
  samples are taken so that this can be judged.
- `n` is fixed in the claim before the run (`samples`), so stopping early can't bias the answer.
- `q` and `α` are decimal strings, and the sums are computed in exact integer arithmetic, so that two implementations
  can't disagree at the boundary. `n` is capped where that stops being cheap.

### A5. The fold

Order the three values `F < U < T`. Then `all` is the minimum of its parts and `any` is the maximum (Kleene's strong
three-valued logic). The fold of a run is `all` over every claim that gates it, taken per subject. A run with no claim
is a usage error.

### A6. What the judge guarantees

These hold for every claim and every view, and are tested with generated claims and facts:

1. **Function.** The same claim and view give the same verdict. No clock, no randomness and no I/O take part.
2. **Order.** Reordering the facts of a view never changes a `set` or `pair` verdict.
3. **Persistence.** A fail of an `every` or `none` claim, and a pass of a `some` claim, stay as they are when facts
   are added to the view. One counterexample or one witness is enough for ever.
4. **No uncovered absence.** A pass of an `every`, `none` or `count` claim, and a fail of a `some` claim, imply
   `covered` was true.
5. **Errors never help.** Turning any item's result into an error, or marking it unusable, never produces a pass or
   a fail that wasn't there.
6. **Monotone fold.** Raising one verdict in the order `F < U < T` never lowers the result.
7. **Seen to fail.** Every claim that gives a pass has a recorded input on which it gives a fail (A7).

### A7. Seen to fail

For a binding of assertion text `t` to a claim `c`, bound on window `W` after action `a`:

```
anchored(t, c)  = every quoted string of t, normalised, is a string literal in c
                  and a `cite` locator, if given, is implied by c
replaced(c, W)  = judge(c', W) != T    where c' is c with each anchored literal replaced by random text not in W
before(c, a)    = judge(c, snapshot before a) != T
broken(c, W, x) = judge(c, W with item x inserted) == F          # for an absence; x is supplied with the binding

counts(binding) = anchored and replaced and before and (broken, if c asserts an absence)
```

`replaced` is what the tie to the text means: a claim that contains the words but would pass whatever they were fails
it. For a shipped claim the same idea is the examples in its file; for a hand-written one, `miqyas lint` runs the same
four tests.

### A8. Depth

```
depth(verdict):
  R = the facts the verdict read, and, through `from`, every fact those were derived from
  if an expression of the claim, or of a derivation it uses, reads a field some fact in R lists in `withheld`: measured
  if a derived fact in R has an input that isn't in the bundle:                                             measured
  if any fact in R is derived:                                                                              derived
  else:                                                                                                     facts
```

---

## B. The gate

### B1. Classing a request

The gate works out the class of each request from the request. A caller may declare a higher class, never a lower one.

```
classOf(req, session):
  if req.cause == page and session.permit == interact:  c = interact       # the page, because of a plan step
  elif req.cause == page:                               c = observe        # the page, during a crawl
  else:                                                 c = probe          # sent by a collector itself
  if not safeMethod(req) and not knownRead(req):        c = max(c, write)
  if route(req) in spendingRoutes:                      c = max(c, write)
  if route(req) in seenToChange:                        c = max(c, write)
  return max(c, req.declared)

safeMethod   = GET, HEAD, OPTIONS
knownRead    = a GraphQL document whose operation is a query; an endpoint a probe's definition lists as a read
seenToChange = routes whose footprint (M4) was seen not to be empty, in this run or in the target model (C)
```

A request the page sends because of a person's plan step stays `interact`, whatever its method: it is the person using
the product. Under an `observe` permit, a page request that comes out as `write` is refused before it leaves, and the
control that caused it is recorded as "would write, not tried". A footprint can only add a route to `seenToChange`:
an empty one never takes a route out, and never makes a request a read.

### B2. Classing an origin

```
classOfOrigin(o, run):
  if the engine started the process serving o in this run, and its only route out is the gate:  sandbox
  if o was named with --allow-host and the ownership token was found:                            owned
  if o is loopback, .localhost or .test:                                                         local test
  if o's name carries a test label:                                                              named test
  if a page of an origin of this run was observed calling o:                                     backend of that origin
  else:                                                                                          other
```

### B3. Deciding

```
decide(effect):
  if a deny rule matches:                                         refuse
  if classOf(effect) > ceiling(classOfOrigin(effect.origin), grants):   refuse
  if the origin is stopped, or its rate is exhausted:             wait or refuse
  allow
  in every case: append an `effect` record with the request, the class found, the rule and the answer
```

`ceiling` is the table in ADR 0008. Three deny rules come with the experiment engine:

- Capturing, restoring and forking (M1) are `disrupt` effects, refused on any origin that isn't a sandbox, whatever
  was granted.
- The rules on Miqyas's own probes (inert markers only; the second account only reads; only ids the test accounts
  own) bind on every origin that isn't a sandbox. In a sandbox an experiment may write as any identity the engine
  made there.
- Planting a seed to measure the engine (N3) is refused on any subject that isn't a copy of an application from the
  public corpus.

### B4. Rate and stop

Each origin has a token bucket, 2 requests a second by default. The first 429 or 503 on an origin stops everything
code chose to send to it for the rest of the run; exchanges recorded after that are marked as following the stop, and
a claim about pages doesn't read them.

---

## C. The target model

The model is what Miqyas knows about a target: its states, the transitions between them, its routes and who may call
them. It is derived from facts, recorded as `model.state` and `model.edge` facts, and compared across runs.

### C1. Which snapshots are the same state

```
state(snapshot) = hash( routeTemplate(snapshot.url),
                        whether a dialog is open,
                        the sorted multiset of (role, normalised name) over rendered interactive and landmark nodes,
                          with runs of like siblings (list rows, cards) collapsed to one entry and a size class
                          of none / one / many )
```

Content that changes by itself (a clock, a counter, the rows of a list) doesn't make a new state; a different set of
controls does.

### C2. Route templates

A path segment is a parameter when it looks like an identifier (all digits, a UUID, eight or more hex characters, a
long opaque token), or when three or more different values were seen in that position under the same prefix. Query
keys are sorted and their values dropped. `/orders/1042/items?page=2` becomes `/orders/:id/items?page`.

### C3. Refining the abstraction

When the same action in the same state leads to different states on two tries, the abstraction is too coarse there.
The state is split by the attribute that best separates the outcomes (first the headings' text, then counts). If no
attribute separates them within a fixed number of splits, the transition is recorded as having several outcomes.

### C4. What changed between two releases

```
diff(A, B) = states, edges and routes in B and not in A (added), and in A and not in B (removed)
           + routes whose answer to a request with no session moved from refusing to answering   -> a finding
           + routes that newly spend money, or newly take a parameter
```

Nothing is asserted about a difference by default; it is shown, and the ones about access become findings.

---

## D. Search

A defect hides in one of a few spaces: the states and sequences of the product, the inputs it accepts, the
combinations of its settings, who is asking, the timing and order of concurrent work, and what fails underneath. Each
has its own way of being searched, its own measure of how much was covered (G2), and its own rule for stopping.

### D1. Exploring states

```
explore(start, limits):
  frontier = priority queue of (state, action) pairs not yet tried
  while frontier not empty and within limits and not saturated (D2):
    (s, a) = frontier.pop()                # highest priority; ties by shallower depth, then by id
    reach s by the shortest known path, do a through the gate, record what changed
    add the new state's untried actions to the frontier
  record why it ended: exhausted | saturated | limit | stopped

priority(s, a) = novelty(s, a) + risk(s, a) − cost(s, a)
  novelty: an action never tried in this state scores highest
  risk:    weights, as data, for what the control or route touches (a form, access, money, deletion)
  cost:    the length of the path needed to get back to s
```

Outside a sandbox the crawl holds an `observe` permit, so an action that would write is refused at the wire (B1) and
recorded. In a sandbox it may do everything.

### D2. When to stop exploring

After `N` actions, let `f1` be the number of states seen exactly once. The estimated chance that one more action shows
a state not seen before is

```
m = f1 / N                          (Good-Turing estimate of the unseen share)
```

Exploration is **saturated** when `m ≤ δ` (2% by default) after a minimum number of actions. A lower bound on how many
states there are is

```
S_total >= S_seen + ((N−1)/N) · f1² / (2 · f2)          f2 = states seen exactly twice, when f2 > 0     (Chao1)
S_total >= S_seen + ((N−1)/N) · f1 · (f1 − 1) / 2       when f2 = 0
```

Both are estimates and are reported as estimates. They assume each visit is an independent draw from a fixed
population. A guided crawl isn't that: it steers toward what it hasn't seen, and for guided fuzzing the same
estimators have been measured to understate the chance of a new discovery, by a wide margin. So they are a reason to
stop spending, and a number to show beside the result, and never a way to turn "not found" into a pass; that stays
the coverage rule's job.

### D3. Covering every transition

Given the model, a tour that fires every known transition: repeatedly take the shortest path from the current state
to the nearest transition not yet fired, fire it, and restart from the start state when none is reachable.
**Cost**: O(edges × (states + edges)). It shows that each transition leads where the model says; it doesn't show that
no two states were wrongly merged, which is what C3 is for.

### D4. Inputs

For each field or parameter, from its declared or inferred type, a fixed table of boundary values, tried before any
random ones:

| Type | Values |
|---|---|
| text | empty; one character; the maximum length and one more; only spaces; combining marks; right-to-left and mixed-direction text; an emoji; ten thousand characters; an inert marker shaped like markup |
| number | 0; 1; −1; the minimum and maximum, and one beyond each; a non-integer; a very large value |
| date and time | the epoch; a leap day; an hour skipped or repeated by a clock change; far past and far future |
| choice | each allowed value; one that isn't allowed |
| file | empty; one byte; the size limit and one byte over; a name with path separators |

For a declared pattern, also a value of the right length that doesn't match it; for a declared type, a value of
another type. Every value in the table is inert: none is markup that runs or the syntax of a query.

Then generated values from a schema, with a recorded random seed and shrinking (D6). Outside a sandbox, inputs go only
where a plan or a probe's definition already sends them.

### D5. Combinations

For `n` settings each with a few values (browser, viewport, language, direction, theme, role, feature flags), a
covering array of strength `t` is a set of configurations in which every combination of values of every `t` settings
appears at least once. Failures that depend on settings are mostly triggered by the interaction of only a few of
them: across the studies NIST collected, two settings together accounted for 62 to 97% of the failures examined, three
for 87 to 99%, and all or nearly all involved six or fewer. So a small array reaches most of them. Those figures
describe the failures in a handful of studied systems, not every system.

```
coverage_t(tests) = (distinct t-way value combinations appearing in tests) / (all valid t-way value combinations)
                    for uniform v values per setting the denominator is C(n, t) · v^t
size of a t-way covering array grows as  v^t · log n
```

The default is `t = 2` (every pair). Arrays are built greedily, one setting at a time (the IPOG construction), with
combinations that can't occur given as constraints.

### D6. Sequences, and shrinking a failure

Sequences of actions are generated as walks over the model from a recorded random seed. When one fails a claim, it is
reduced to the shortest sequence that still fails (H1), bound, and saved as a plan, so that every failure exploration
finds becomes a regression plan.

### D7. Who is asking

The authorisation matrix has a cell for every role (including nobody) and every route.

```
expected(role, route)  = allow, if that role's own pages were observed calling the route
                         deny,  otherwise
violation(role, route) = expected is deny, and the replayed request leaks (L3): the role receives something of
                         the owner's that its own interface doesn't offer it
coverage = cells replayed / (roles × routes)
```

A status code is recorded and never decides (L2): an application can refuse with a 401, a 404, a redirect, or a page
that says so with a 200. This is the general form of the "one account can't read another's records" and "routes
behind log-in give nothing to a request with no session" checks. Both are the `who` law of L3, and their port uses
that rule from the start.

### D8. Faults and interleavings

**Faults.** A clean run records every point where the target reached outside itself: each outgoing call, each write
to disk, each message. A fault plan is a set of (point, mode) pairs, where the modes are: fail, delay, drop, repeat,
reorder, and crash just after.

```
fault coverage = (point, mode) pairs exercised / (points × modes)
```

The denominator is the points seen in a clean run, widened by any point that only appears after a fault was injected;
it is stated as "N of M points seen", because a list of every call site in the code would include ones that can't be
reached. The plan covers every single pair first, in the order the points occurred, then a sample of pairs of faults.
Each run uses a recorded random seed, and the invariants of F5 and F6 are checked after each. Full coverage here says
every point was failed once in every mode and the invariants held; it isn't a proof of fault tolerance.

**Interleavings.** Where Miqyas controls scheduling (an engine built to be tested this way), it runs the randomised
priority scheduler of probabilistic concurrency testing: give each of `n` tasks a random priority, pick `d − 1` random
points among the `k` steps at which the running task's priority drops below all others, and always run the
highest-priority task that can run. For a defect that needs `d` ordering constraints to show,

```
P[one run finds it] >= 1 / (n · k^(d−1))
runsNeeded(n, k, d, α) = ceil( ln α / ln(1 − 1/(n · k^(d−1))) )
```

`n` is the most tasks alive at once, `k` the most steps in a run, and `d` the fewest ordering constraints that expose
the defect. The bound is proved for threads under a scheduler that controls every step; for messages between
processes it is a guide, with "step" and "constraint" defined for that system, and it weakens quickly as `k` and `d`
grow. Faults and controlled scheduling are `disrupt` and run in a sandbox.

### D9. Spending the budget

Every explorer (the crawl, input generation, the authorisation matrix, fault plans, an agent proposing where to look)
is an arm. Its reward for a slice of time or money is the share of still-uncovered obligations it covered, in [0, 1].
The engine gives the next slice to the arm with the highest

```
mean reward_i + sqrt( 2 · ln N / n_i )          N = slices given so far, n_i = slices given to arm i      (UCB1)
```

so an explorer that keeps finding new ground is fed, and one that has gone quiet is tried only now and then. An agent
gets no special standing: it is fed when what it proposes adds coverage. The rule's published guarantee assumes each
arm's rewards don't change over time, and here they shrink as coverage fills in, so it is used as a sound habit for
sharing a budget, not for its bound.

---

## E. The run engine

```
run(request):
  claims  = resolve(request)                    # E1
  graph   = match(claims)                       # E2
  plan    = fit(graph, request.limits)          # E3     --dry-run and the quote stop here
  collect(plan)                                 # E4     judging happens as views close (E5)
  seal()                                        # E6
```

**E1. Resolve.** Gather the claims of the plans (through their bindings), the profiles and the flags. Record each
claim file in the ledger. A claim with no failing example is `unverified` before anything runs.

**E2. Match.**

```
match(claims):
  for c in claims:
    need = kinds(c.view) and the kinds its derivations consume, followed back to kinds only collectors record
    for each kind in need: the collector the view names, or the only one that records it; none -> c is blocked
    for each chosen collector: its inputs, tools and effect class must be available; if not -> c is blocked,
      and what to add is the list of what is missing
  return the graph: collectors and derivations as nodes, "records a kind the other consumes" as edges
```

The graph is over kinds, so it is fixed before anything runs. What a crawl decides to visit next is inside the crawl.

**E3. Fit.** Estimate each node's time and cost from its limits. If the total exceeds the time limit, remove the nodes
that serve only the lowest-priority claims, ties by claim id, until it fits; those claims are `not_checked`, dropped
for time. The estimate of model cost is the quote.

**E4. Collect.** Run nodes in dependency order, independent ones in parallel, each under a deadline and a permit. One
writer appends to the ledger. A node that fails or times out gets a failed `collection` written for it. A retry is a
new run of the node, and views read the last.

**E5. Judge.** When a view's last collector run closes, judge its claim once (A1 to A4), run its seen-to-fail check
where it has one (A7), compute its depth (A8), and append the verdict.

**E6. Seal.** Fold per subject (A5), append the seal, write the checkpoint (K3), print the head, render the views.

---

## F. Oracles

An oracle is what decides that an observed behaviour is wrong. The usual division is into three kinds of oracle and
the case where there is none and someone has to look. Miqyas uses all of them and labels which one stands behind a
verdict:

| Source | In Miqyas | Stands behind |
|---|---|---|
| specified | an assertion, a readiness check, a contract or schema | a claim |
| derived | a relation between runs, agreement between two versions or implementations, the target's own past | a `pair` claim (F1 to F3) |
| implicit | things that are wrong whatever the product is: a crash, an uncaught error, a 5xx, a hang, a leaked key | a derivation that records findings |
| none: a person or a model looks | an assertion marked for a model | a pass with basis `opinion`, counted apart |

### F1. Relations between two runs

When nobody can say what the right output is, it is often still possible to say how two outputs must relate. Each of
these is a `pair` claim; the left side is a first run, the right side a second run after a known change.

| Change | What must hold |
|---|---|
| direction flipped to right-to-left | each node's box is mirrored: `x' = W − x − w`, within a tolerance |
| viewport, zoom or theme changed | the same controls are there, by role and name; none is clipped away |
| language changed | the same structure; no text left in the first language where a translation exists |
| the same safe request sent twice | nothing the application shows has changed (L5) |
| a filter added to a search | the results are a subset of the results without it |
| a list paged | the pages don't overlap and together equal the whole list |
| a list sorted | the same items, in order |
| a write repeated that is meant to be idempotent | the second changes nothing more in what the application shows (L5) |

### F2. Two versions, two implementations

The same plans and probes are run against two subjects and compared item by item: an old build and a new one; a mock
and the service it stands for; one platform and another. The harness contract check is this shape: every command the
app can send must get an answer from the mock, and a mock that stays silent fails.

### F3. Conformance

Where a target declares a contract (an OpenAPI or GraphQL schema, a JSON Schema), a derivation validates every
recorded exchange against it and records each violation; the claim is that there is none, covered when every declared
operation was exercised at least once.

### F4. Settling

```
settled(page, quiet = 500 ms, limit):
  true once, for `quiet` without a break: no request the page caused is pending, no node was added, removed or
  changed, and no animation is running; false if `limit` passes first
```

A snapshot records whether it was taken settled. An absence is never judged on a snapshot that wasn't.

### F5. Histories

An engine under test records a history: each operation's invocation and its completion as ok, failed, or unknown
when the caller never learned the outcome. A checker decides whether the history is one a correct system could have
produced.

```
linearizable(history, model):
  search for an order of the operations that respects real time (an operation that completed before another began
  comes first) and that the model accepts, treating an unknown operation as either having happened or not;
  remember (set of operations placed, model state) pairs already tried; check keys that don't interact separately
  -> valid | invalid, with the shortest prefix that can't be ordered | unknown, when the search budget ran out
```

The problem is hard in general, so the budget is part of the contract and running out of it is `unknown`, never
valid. Checkers for transactional anomalies come in as adapters.

### F6. Replicated state

For an engine that keeps copies in step (a sync engine, a replicated store), over a history with its fault log:

```
converges     after the last fault is healed and no operation is pending for a settle period,
              every replica's state has the same digest
loses nothing every write the engine acknowledged is, in the final state, either current, or kept in the engine's
              history or bin, or was replaced by a write that happened after it
no silent overwrite   for two writes to the same item where neither happened after the other, both versions can
              still be retrieved
```

"Happened after" is the order the engine itself assigns (its version vectors or equivalent), recorded with each write.

---

## G. Assurance

### G1. The record per claim

Every verdict carries: the claim and its view; its coverage (G2); its depth (A8); its kind of assurance (`tested`,
`bounded`, `proved`); how it was seen to fail (A7); for a sample claim, `n`, `k` and the confidence; and whether its
basis is a rule or an opinion. A report shows these per claim and never combines them (ADR 0015).

### G2. Coverage, by space

Each measure has a numerator Miqyas counted and a denominator Miqyas enumerated or estimated, and says which.

| Space | Measure | Denominator |
|---|---|---|
| states | states visited / states known; why exploration ended; the unseen share `m` (D2) | the model, with an estimate of what is unknown |
| transitions | transitions fired / transitions known | the model |
| routes | routes exercised / routes seen, per role (D7) | the model |
| inputs | boundary values tried / boundary values for the field's type (D4) | the table |
| combinations | t-way combinations covered / all valid ones (D5) | computed exactly |
| faults | (point, mode) pairs exercised / all pairs (D8) | points from a clean run × modes |
| code | functions and blocks run / functions and blocks shipped, from the browser's own coverage | the served scripts |
| a domain | items examined / items enumerated, for the claim's own domain | the enumeration, recorded as facts |
| requirements | requirements with a passing claim / requirements stated | a list a person supplies |

Code coverage is shown because it says what was never run at all. It is never used as evidence that what was run was
checked: executing a line isn't asserting anything about it.

### G3. Confidence from clean runs

From A4: after `n` runs with no failure, the failure rate is below `1 − α^(1/n)` at confidence `1 − α`. To claim a
rate below `ε`, `ceil(ln α / ln(1 − ε))` clean runs are needed. Miqyas uses this on itself: to state that fewer than
2 in 100 runs fail on a clean build, at 95%, takes 149 clean runs.

### G4. Sensitivity by mutation, in a sandbox

For each bound assertion that passed, break what its witness rests on in a served copy (hide the node, change its
text, remove it), confirm with a code probe that the break took effect, and judge the bound claim again:

```
detection rate = assertions that failed on their own break / breaks confirmed effective
```

A break that had no effect isn't counted either way, and a break caught only by some other assertion is counted
apart. Bound plans need no model, so this is free to repeat. It measures sensitivity: mutants and real defects are
related, not the same.

### G5. Planted defects

Per release, on the corpus: every shipped claim must catch each of its seeds and stay quiet on its clean twin.

```
caught(claim)  = seeds the claim failed on / seeds planted for it
quiet(claim)   = clean twins on which the claim passed / clean twins
```

Scores are given per claim and per part of the corpus and never blended. The run that produces them is itself a proof
bundle.

### G6. A profile as an assurance case

A profile maps onto the usual structure of an assurance case without change: the top goal is "this subject is ready at
this grade"; the strategy is the profile; each pillar and claim is a sub-goal; each verdict, with its record, is the
evidence; the environment class, the coverage limits and what a bundle can't show are the stated context and
assumptions. It can be exported in that form.

---

## H. Diagnosis

### H1. The smallest input that still fails

Delta debugging: split the failing input (a sequence of actions, a set of settings, a payload) into `g` parts; if one
part alone still fails, continue with it; if the input without one part still fails, continue with that; otherwise
double `g`; stop when no single element can be removed.

```
ddmin(input, fails):   returns an input no single element of which can be removed without losing the failure
tests needed:  at most n² + 3n; at most 2·log2(n) when one element alone causes the failure
```

The result is minimal in that sense, not the smallest failing input there is.

Each test is a run in a sandbox, or a replay of bound actions, so it costs no model call.

### H2. One finding per cause

Failures are grouped by a signature: the claim, the kind and normalised text of the first error, the top frames of a
stack with line numbers removed, and the shape of the counterexample. One group is one finding with a count.

### H3. Which code to look at first

With code coverage recorded per plan, each function gets a suspiciousness from how often failing and passing plans
ran it:

```
suspiciousness(s) = ef / sqrt( (ef + nf) · (ef + ep) )            (Ochiai)
  ef = failing plans that ran s    nf = failing plans that didn't    ep = passing plans that ran s
```

The ranking is computed by code from recorded coverage; source never goes to a model. It is a place to start looking,
and is labelled as that: studies with developers found that a ranked list helps less than its accuracy on planted
faults suggests.

### H4. Which change introduced it

When a claim passes on one commit and fails on a later one, bisect: build the middle commit in a sandbox, run only
that claim's collectors, and halve the range. `ceil(log2(commits))` builds.

### H5. Flaky or broken

A claim's verdict is a function of the facts, so a verdict can't itself be flaky; what can differ between two runs is
what the collectors recorded. When a claim fails, its collectors are run again a fixed number of times, and all
attempts are kept:

```
stable fail   every attempt failed
flaky         some attempts passed: still a fail, labelled flaky, with k of n and the bound of A4 on its rate
```

A pass on a retry never replaces a failure. To decide between "fails almost always" and "fails now and then" with
bounded error and as few runs as possible, the sequential test is used: after `n` attempts with `k` failures,

```
Λ = k · ln(p1/p0) + (n − k) · ln((1 − p1)/(1 − p0))
stop and call it broken when Λ >= ln((1 − β)/α);  flaky when Λ <= ln(β/(1 − α));  otherwise run again
```

The two thresholds are the standard approximations, and the number of attempts is capped, so the error rates `α` and
`β` are close to, not exactly, what was asked for.

---

## I. Economy

### I1. Not repeating work

A tool run or a derivation is a function of its inputs, so its result can be reused:

```
key = SHA-256( tool or derivation id@version, its arguments, the digests of its inputs )
```

A cached result is recorded in the new bundle as a fact with its origin, so the bundle still verifies by itself.

### I2. Re-running only what a change calls for

Between two subjects, the changed functions are known from the two builds. A plan's dependencies are the functions it
ran, from recorded code coverage.

```
select(plan) = the plan ran a function that changed, or was never run on the old subject, or failed there
```

A plan that isn't selected keeps its old verdict, recorded in the new bundle as carried, with the bundle it came from.
A carried verdict is weaker than a fresh one and is shown as carried; a gate may limit how old one can be. Selection
is safe only as far as coverage is complete and the plan is deterministic, which is why it is offered for bound plans
and not for exploration.

### I3. Failing fast

Within what was selected, collectors run in order of the chance their claims fail, per unit of cost: claims that
failed recently and claims touching changed code first.

---

## K. The record

### K1. The tree

Over the ledger's lines `d0 … d(n−1)` as stored, without their newline:

```
root({})         = SHA-256("")
root({d0})       = SHA-256(0x00 ‖ d0)
root(d0 … d(n−1)) = SHA-256(0x01 ‖ root(d0 … d(k−1)) ‖ root(dk … d(n−1)))     k = the largest power of two below n
```

### K2. Proving one record belongs

The proof that line `i` is in a ledger of `n` lines is the list of sibling hashes on the path from its leaf to the
root: about `log2(n)` hashes. With it, one verdict and the facts it read can be handed over and checked against a
published head without the rest of the bundle.

### K3. The checkpoint

Three lines: an origin naming the run, the number of lines, the root in base64; then signature lines, when there are
any. It is rewritten at intervals and after the seal.

---

## L. Experiments

Parts L to N specify the [experiment engine](ENGINE.md). Every law below is a shipped claim, judged by A1 or A2 over
recorded runs. An experiment records no result of its own.

### L1. An experiment

```
experiment(capsule S, axis, operation):       # a collector's work: it records, and doesn't judge
  calibrate:  run the reference request twice from S; fields that differ between the two are volatile (L2)
  reference:  fork S; run the operation as its owner, undisturbed; record
  test:       fork S; run it again, changed along the axis only; record; then once more from a new fork
  checks:     reference_ok    the reference run returned the data and left its expected footprint
              identity_live   a request the test identity is allowed to make succeeded in the same fork
              same_state      the fidelity check (M2) passed for this recipe in this run
              agree           the two test runs compare the same
              allowed         the gate refused none of the runs
  record:     one `experiment` fact

experiment fact body:
  { axis, operation,                            // the operation as a method and route template, or a control
    capsule,                                    // its digest (M1)
    runs: [{ role: calibrate | reference | test, facts: [positions] }],
    checks: { reference_ok, identity_live, same_state, agree, allowed } }     // each true or false

the law, a shipped claim (A1 or A2):
  where    the rule that says the law applies to this operation (L9)
  usable   every check of the experiment is true, and none of the law's own "can't tell" conditions holds (L3 to L8)
  holds    the relation of L3 to L8, on what the runs recorded and what derivations computed from it

cell(operation, axis), read off how the judge sorted that item:
  doesn't apply   outside              held         holds
  broken          fails                can't tell   uncertain
  not tested      no experiment was recorded for an operation the law applies to
```

A cell is recorded beside whatever else is known about the operation and never replaces it.

### L2. Comparing by content

```
volatile(operation)  = the fields that differed between two identical runs from the same capsule
volatile(R)          = for a sequence of reads R, the fields that differed between two replays of R from the same
                       capsule with nothing done in between
tokens(response)     = the keyed digests of every distinctive leaf value in the response, volatile fields left out
                       distinctive: text of 8 characters or more, a number of 6 digits or more, an id
digest(value)        = HMAC-SHA-256(key of this run, normalise(value))
```

The key is made per run and thrown away at its end. Two digests can be compared for equality, within a run and when
re-judging its bundle, and nothing can be recovered from them. Digests from two runs can't be compared, which is why
the `build` axis runs both builds in one run (L8). Status codes are recorded and never decide a law.

### L3. `who`

```
read:
  own     = tokens(reference run)                      what the owner receives
  other   = tokens(test run)                           what the lesser identity receives for the same request
  offered = tokens the lesser identity received anywhere through its own interface in this run
  leak    = (own ∩ other) − offered
  can't tell when own is empty: the reference run returned nothing distinctive to look for
  held       when leak is empty; `offered` can only grow, so more exploring can't change this
  broken     when leak is not empty, and the lesser identity's interface was explored to its coverage rule
  can't tell when leak is not empty and the exploring fell short

write, for an operation that names an object the owner already has in S: a change, a deletion, an action on it,
or a creation under it (a line on the owner's invoice, a comment on the owner's record)
  touched = the owner's rows in S that the reference run changed, and what the owner then reads back of them
  broken  when the test run, sent as the lesser identity, changed any row in touched,
          or changed what the owner reads back
  doesn't apply to a creation that names nothing of the owner's
  doesn't apply when the lesser identity's own interface offers that action on that object
```

The answer to a write doesn't show whether it took effect, so a write is always judged on what is read back.
Data that is meant to be shared is in `offered`, because the lesser identity's own pages show it. A response of 200
with an empty list leaks nothing and holds. The identities tried are every pair the run was given accounts for, and
nobody.

### L4. `door`

```
for each constraint c the interface or the schema declares on a field of the operation
    (required, a length, a pattern, a range, a type, a fixed set of options):
  v = a value that breaks c, from the table of D4
  send the operation directly with v
  broken when the stored value equals v            the forbidden value went in unchanged
  held   when nothing was stored, or what was stored satisfies c

for each field g that the object carries and the interface never sends in this operation:
  send the operation directly with g set to a value w that the undisturbed run doesn't store
  broken when the stored g equals w                the server took a field the interface never sends
```

### L5. `again`

```
shown(S) = for each identity, the tokens (L2) of a fixed sequence of reads R replayed on S, volatile(R) left out

safe (GET, HEAD, OPTIONS):      broken when shown(after the request) differs from shown(before)
repeatable (PUT, DELETE, or a request carrying the same idempotency key):
                                broken when shown(after twice) differs from shown(after once)
```

What is safe and what is repeatable is what the protocol defines, and it defines them on the effect that was asked
for: a server may log each request, keep a revision or count it. So the law is judged on what the application shows,
and the footprint (M4) is recorded beside it without deciding.

### L6. `together`

```
s_ab = state after a, then b          s_ba = state after b, then a
for try i in 1..N:  s_i = state after a and b released at the same moment by the proxy
broken        when some s_i is neither s_ab nor s_ba
held in N     otherwise

tried on pairs of writes whose footprints (M4) touch the same table
states are compared over those tables, and over shown(S) of L5
```

Holding in `N` tries is not holding. If a collision shows in a share `p` of tries, `N` clean tries miss it with
probability `(1 − p)^N`; to be 95% sure of seeing one that shows in a tenth of tries takes 29. The report gives `N`.

### L7. `failure`

```
points = each statement and outgoing call seen in the undisturbed run, in order
for each point i and each mode (fail, time out):
  run with that one fault
  f_i = footprint_i, leaving out rows in stores the recipe or the book marks as logs or audit trails,
        which rightly stay
  broken when f_i is neither empty nor the whole undisturbed footprint               a partial change
  broken when f_i is empty and the response compares the same as the undisturbed one (L2)     a swallowed error
```

### L8. The other axes

```
round trip     write v, read it back; broken when what is read differs from v after the declared normalisation;
               v ranges over the boundary values the declaration allows (D4)
after          end the session, delete the account or revoke the token; send the reference request with the old
               credential; broken when it leaks (L3, with nobody as the lesser identity)
view           for two views of one quantity in one state (a count and its rows, a total and its lines):
               broken when they differ
build          the same experiment on the previous build and this one, both in this run; broken when an
               operation the change did not touch behaves differently
presentation   the relations of F1
```

### L9. The matrix

```
cell(operation, axis) = doesn't apply | not tested | held | held in N | broken | can't tell (why)
coverage(axis)        = cells tested / cells that apply
```

Which cells apply is decided by rule (a `door` cell needs a declared constraint; a `together` cell needs two writes
with overlapping footprints), and the rule is recorded. A report prints the matrix, and coverage per axis, and never
one number for the whole.

---

## M. Capsules and state

### M1. A capsule and its recipe

```
capture(sandbox) -> capsule        restore(sandbox, capsule)        fork(capsule) -> sandbox

recipe(stack) = a declaration, which the engine reads, and those three procedures
  { id, version,
    start:  the containers to run, and how to tell they are up,
    stores: [{ name, kind: database | sessions | cache | queue | files | clock | service,
               mode: captured | reset | outside, perFork: own | shared }] }

  captured   capture saves its content; restore and fork put that content back
  reset      nothing is saved; restore and fork return it to one fixed start the recipe names:
             an empty cache, counters at zero, the clock at the time of the capture
  outside    the recipe can neither save it nor reset it; the cells that depend on it are "can't tell",
             unless its answers are replaced by recordings
  shared     one instance serves every fork, so forks run one at a time

capsule = SHA-256 of its manifest: the recipe as id@version and, for each store, its mode and the digest of what
          was saved

capsule fact body:
  { capsule, recipe, stores: [{ name, kind, mode, perFork, digest? }],
    state,                                      // the digest of M3 over the captured databases
    parent? }                                   // the capsule it was restored or forked from
```

The `capsule` fact holds the manifest, so the record still says what a capsule was after the capsule is deleted.
Capture, restore and fork are `disrupt` effects that a deny rule confines to a sandbox (B3). Forks run side by side
only when every store is `own`.

### M2. The fidelity check

```
fidelity(sandbox, recipe):
  R = for each identity of the run, the reads recorded while the state was reached, in the order recorded,
      up to 50; with no read recorded the check can't run
  replay R twice with nothing in between; what differs is volatile(R) (L2)
  c = capture(sandbox); restore(sandbox, c); replay R                 # restored
  f = fork(c); replay R on f                                          # forked
  same = in each replay, every response has the tokens (L2) it had before, volatile(R) left out

fidelity fact body:
  { recipe, capsule, reads,                     // how many reads were replayed
    restored: { same, moved: [positions] }, forked: { same, moved: [positions] } }
```

Run once per capsule recipe per run, before any experiment. If it fails or can't run, every experiment on that recipe
is "can't tell", and the report names the reads whose answers moved.

### M3. The digest of a state

```
listing(sandbox) = for each table in name order: its rows in order of their natural key;
                   each row as its columns in name order, each value as its keyed digest (L2);
                   a column that refers to another row given as that row's natural key;
                   generated columns and volatile columns (L2) left out
state(sandbox)   = SHA-256 over listing(sandbox)
```

A natural key is a unique key that doesn't depend on the order of insertion; where a table has none, its rows are
compared as a multiset. Two paths that reach the same logical state have the same digest even though the ids and
times they generated differ, which is why a reference to another row is given by key and not by id. The listing is
recorded as a blob; `state` and footprints (M4) are derivations over listings, so both can be re-run from a bundle.

### M4. A footprint

```
footprint(action, S) = rows added, changed and removed between listing(S) and listing(S after action),
                       by table and column, matched by natural key;
                       plus the requests the action sent, and what the page shows

footprint fact body:
  { action,                                     // the position of the action's record
    before, after,                              // the two state digests (M3)
    rows: [{ table, key, change: added | changed | removed, columns: [names] }],
    requests: [positions],
    stores: [names] }                           // the stores the recipe captures: all that a footprint covers
```

A footprint covers the stores its recipe captures and says which those are. It may raise the class the gate gives a
request (B1) and never lower it.

### M5. Reaching states

```
makes(o)    = the kinds of id that appear new in o's responses or footprint
needs(o)    = the kinds of id that o's request carries
order       = any order of operations in which each need is made before it is used

archive     = { (state of the page (C1), state of the data (M3)): capsule }
goal        = each account owns at least one of each kind of thing, checked by footprints
```

The engine walks toward the goal from the archive, forking from the nearest state that already satisfies part of it.
An agent may propose the steps for a path code can't work out; the footprint decides whether it worked.

### M6. Where two runs part ways

```
firstDivergence(a, b):
  put the two runs' events in order, volatile fields left out
  return the first position at which they differ, with the events on each side
```

Reported with every broken law, as the place to start reading.

---

## N. Where to look first, and how the engine is measured

### N1. The order of testing

```
1. operations a change touches, found from the files each was read from
2. writes before reads; money, access and deletion first
3. pairs of writes with overlapping footprints, for `together`
4. entities that lack a protection most of their peers have (N2)
5. cheapest first within each group
```

This order decides what is tested first and nothing else. It stays a fixed order until there is held-out data to fit
weights on.

### N2. Peers, as a map

A property is marked by whoever writes its extractor as **protective** (lacking it is the risk), **hazardous**
(having it is the risk) or **descriptive**. Only protective and hazardous properties are reported; descriptive ones
only draw classes. A feature that is the property's own mechanism never draws a class.

```
n       = the number of entities in a class, counting near-copies and the output of one generator once
k       = how many have the protection
L(n, k) = the value such that P(compliance >= L | k of n) = 0.95, with a flat prior
          with no exception:  L = 0.05^(1/(n + 1))        n = 8: 0.72     n = 15: 0.83     n = 28: 0.90
a class is kept when most of it has the protection and n >= 8
```

Output, for each protective property: the entities that lack it, each either explained in the book or open; and, for
each class where most lack it, "this class has no such protection", checked against the universal laws. `L` orders
the list and is a rank, not a probability. A first trial of this method as a detector of defects found none in 70
exceptions read by hand (ENGINE §12); it is kept as a map and as an order of testing.

### N3. Measuring

```
real defects   for each published defect with a fixing commit: run the engine on the commit before;
               shown | not shown | no experiment exists for it
seeds          a seed counts only with a test, written by whoever planted it, that shows it without the engine
held out       anything fitted is fitted on some applications and reported on others
labelled       what the engine reports on an application judged clean is read by a person, under published rules
```

### N4. What is reported

```
per axis and per kind of defect:
  shown    = defects shown / defects in the set, real and seeded given apart
  right    = broken cells judged a real defect / broken cells
  missing  = defects for which no experiment exists
  cost     = runs per defect shown
```

Never blended (ADR 0015). `shown` on seeds says how well the engine finds what was planted, and is described as that.
