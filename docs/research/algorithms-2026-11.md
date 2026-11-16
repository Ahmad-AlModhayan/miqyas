# Algorithms: fact-check of the formulas and guarantees (2026-11-16)

Research for [ALGORITHMS.md](../ALGORITHMS.md). Each item takes a statement from a draft of that chapter, says whether
it was correct, gives the exact form from the source with its assumptions, and names libraries. Where a draft statement
was wrong or loose, the chapter uses the corrected form given here.

Tags: [V] verified on 2026-11-16 from a primary source (paper text, official docs, repository or registry metadata).
[S] secondary source (abstract pages, citing papers, search results). [M] recalled, not re-checked.
Library facts (licence, version, date) were read from npm, crates.io and GitHub metadata on 2026-11-16.

## 1. Probabilistic Concurrency Testing (PCT)
**Draft statement: correct** (precision added below).
**Exact form:** In one run of a program with at most n threads and at most k instructions, PCT finds a bug of depth d with probability >= 1/(n * k^(d-1)). [V] (abstract and Theorem 9 of the paper).
- n >= max threads, k >= max steps executed (instructions; with the paper's optimisation, k counts only synchronisation operations). d = bug depth = minimum number of ordering constraints (scheduling constraints on events) that suffice to reveal the bug. [V]
- Algorithm [V, Section 3 and Fig. 5]: (1) give the n threads a random permutation of the initial priorities d..d+n-1; (2) pick d-1 priority change points k_1..k_{d-1} uniformly and independently from [1,k], where change point k_i carries the low priority value i; (3) at every step run the highest-priority enabled thread, one thread at a time; (4) when the executed step count reaches k_i, set the running thread's priority to i; (5) repeat with fresh random choices on every run. For d = 1 there are no change points.
- Runs for confidence 1-alpha: with p = 1/(n k^(d-1)) and independent runs, P(find in r runs) >= 1-(1-p)^r, so r >= ln(alpha)/ln(1-p). Correct. Simplification r >= ln(1/alpha) * n * k^(d-1) is slightly conservative, because ln(1-p) <= -p. Example: n=4, k=1000, d=2, alpha=0.05: p = 2.5e-4, r = 11,982 (the approximation gives 11,983). [computed]
**Assumptions:** d is supplied (the tool picks it from a distribution); the scheduler controls all scheduling points (serialised execution); the bug is hit by the schedule with the stated ordering constraints; independent random choices per run. The bound is worst case and tight (Fig. 4 example). [V]
**Source:** Burckhardt, Kothari, Musuvathi, Nagarakatte. "A Randomized Scheduler with Probabilistic Guarantees of Finding Bugs." ASPLOS 2010, pp. 167-178, doi:10.1145/1736020.1736040. https://people.cs.rutgers.edu/~sn349/papers/asplos2010.pdf
**Limits:** The bound is for thread schedules. For an async event loop, a browser or distributed message order, it is only an analogy ("steps" and "ordering constraints" have to be defined for the system at hand). The bound is weak when k is large (1e6 steps, d=3 gives 1e-12 * 1/n). Real bugs often need d >= 3 or data-dependent inputs. Using sync-points only for k needs a data-race classifier. [M for the last two]
**Libraries:** Rust: `shuttle` (AWS), Apache-2.0, 0.9.10, 2026-11-05, has `PctScheduler` [V]. `loom` (MIT, 0.7.3, 2026-11-08) is bounded exhaustive, not PCT [V]. TypeScript/JS: none identified (JS is single-threaded; fast-check's `fc.scheduler` is random ordering, not PCT [M]). Microsoft Coyote (.NET) implements PCT for tasks [M].

## 2. Good-Turing, Chao1, STADS and residual risk
**Draft statement: correct for Good-Turing; imprecise for Chao1 (it is a lower bound, and the (n-1)/n factor is missing from the bias-corrected form).**
**Exact form:**
- Good-Turing discovery probability U_hat(n) = f1 / n, where n = number of observations (inputs) and f1 = number of species (classes) observed exactly once. Estimates the probability that the next observation is a previously unseen species ("missing mass"). [V: STADS, eq. in Sect. on estimation]
- Chao1 as printed in STADS: S_hat = S(n) + f1^2 / (2 f2) if f2 > 0 (their eq. 12 form), and the bias-corrected version used in STADS eq. 11: S_hat = S(n) + ((n-1)/n) * f1^2/(2 f2) if f2 > 0, and S(n) + ((n-1)/n) * f1(f1-1)/2 if f2 = 0. [V] S(n) = species observed, f2 = species observed exactly twice. Often quoted alternative: S_obs + ((n-1)/n) * f1(f1-1) / (2(f2+1)) [M]. Chao1 is a **lower bound** on richness, unbiased only if undetected and singleton species have about equal abundance. [V, STADS, section on estimators]
**What Boehme claims:**
- STADS (TOSEM 2018): treat testing as sampling species (program behaviours: branches, paths, bugs); estimate discovery probability with Good-Turing and species richness / coverage G = S(n)/S_hat with Chao1; shows Good-Turing U_hat(n) gives an upper bound on the probability that an error remains undiscovered after n errorless inputs. [V]
- STADS assumption: relative species abundances p do not substantially change during the campaign; feedback-directed fuzzers violate it (adaptive sampling bias), argued to shrink as the campaign progresses. [V]
- FSE 2021 (Boehme, Liyanage, Wuestholz): residual risk cannot be estimated directly for greybox campaigns; the discovery probability (probability that the next input increases coverage) is an upper bound on residual risk; blackbox estimators (including Good-Turing) systematically and substantially under-estimate the true discovery probability in greybox campaigns (up to four orders of magnitude in their experiments); they propose reset (1-reset, 10-reset) and mean-local estimators. [V]
**Assumptions the guided crawl violates:** i.i.d. draws from a fixed multinomial over species. A crawler that retains interesting states and biases toward frontier states changes the sampling distribution each step (adaptive bias). Also "species" must be well defined (what counts as the same state), and sampling is not with replacement from a fixed population. The FSE 2021 corrections are validated on fuzzing only [V]; no evidence they transfer to GUI crawling.
**Source:** Boehme. "STADS: Software Testing as Species Discovery." ACM TOSEM 27(2), 2018, doi:10.1145/3210309, https://arxiv.org/abs/1803.02130. Boehme, Liyanage, Wuestholz. "Estimating Residual Risk in Greybox Fuzzing." ESEC/FSE 2021, pp. 230-241, doi:10.1145/3468264.3468570, https://mboehme.github.io/paper/FSE21.pdf. Good (1953), Biometrika, "The population frequencies of species and the estimation of population parameters" [M]. Chao (1984), Scand. J. Stat. [M].
**Limits:** Good-Turing is accurate for n large with many rare species; MSE < 1/n under multinomial [V as cited in STADS]. Chao1 is only a lower bound.
**Libraries:** none needed (a few lines of code); R packages `iNEXT`, `SpadeR` exist [V, named in STADS].

## 3. Combinatorial interaction testing
**Draft statement: imprecise.** Numbers are cumulative percentages and the ranges differ.
**Exact table** (NIST SP 800-142 "Practical Combinatorial Testing", Appendix B, Table 1; cumulative % of failures triggered by <= t variables) [V]:

| t | Medical | Browser | Server | NASA GSFC | Network security | TCAS (seeded) |
|---|---|---|---|---|---|---|
| 1 | 66 | 29 | 42 | 68 | 17 | n/r |
| 2 | 97 | 76 | 70 | 93 | 62 | 53 |
| 3 | 99 | 95 | 89 | 98 | 87 | 74 |
| 4 | 100 | 97 | 96 | 100 | 98 | 89 |
| 5 | | 99 | 96 | | 100 | 100 |
| 6 | | 100 | 100 | | | |

**Correction:** two-way: 62-97% for the naturally occurring failures (53% for TCAS, which used seeded faults), not "70-97%". Three-way: 87-99% (74% TCAS), not "90-99%". Four-way: 89-100%. All six studies reach 100% by t = 6 (medical and NASA at 4). NIST's own wording is "all or nearly all failures involve only 1 to 6 factors"; the page does not claim that no failure ever needed more than 6 [V]. The original TSE 2004 paper covered fewer systems (medical, browser, server, NASA) than this table [M].
**Covering arrays:** CAN(t, n, v) = O(v^t log n) for n parameters with v values at strength t (Gargano-Koerner-Vaccaro; Godbole-Skipper-Sunley) [M]; trivial lower bound v^t. Coverage measure: covered t-tuples / (C(n,t) * v^t) for uniform v, correct without constraints; with constraints, infeasible tuples leave the denominator [M]. Kuhn et al. also define "total t-way coverage" over all variable-value combinations [M].
**IPOG:** Lei, Kacker, Kuhn, Okun, Lawrence, "IPOG: A General Strategy for T-Way Software Testing," ECBS 2007; extended in "IPOG/IPOG-D: efficient test generation for multi-way combinatorial testing," Software Testing, Verification and Reliability 18(3), 2008 [M]. Horizontal growth (extend existing rows with the next parameter) then vertical growth (add rows for uncovered tuples).
**Source:** Kuhn, Wallace, Gallo. "Software fault interactions and implications for software testing." IEEE TSE 30(6), 2004. NIST page: https://csrc.nist.gov/Projects/automated-combinatorial-testing-for-software/combinatorial-methods-in-testing/interactions-involved-in-software-failures [V]. Table: https://nvlpubs.nist.gov/nistpubs/legacy/sp/nistspecialpublication800-142.pdf [V].
**Limits:** Few studies, different fault sources (field recalls, bug trackers, seeded faults); percentages are of failures studied, not of all faults; constraints and input-space modelling dominate real effort; fault-interaction data is about parameter interactions, not state sequences.
**Libraries:** Microsoft PICT: MIT licence [V file]; latest release v3.7.4 (2022-03-31), repo active (push 2026-10-14) [V]. NIST ACTS: Java; NIST page says "No license is required and there are no restrictions on distribution or use" (US Government, public domain), advanced version 3.3 guide [V]; the GitHub mirror `usnistgov/combinatorial-testing-tools` is archived [V]. JS/TS: `covertable` (Apache-2.0, 3.4.0, 2026-09-13, TypeScript, N-wise, constraints) [V metadata, S for description; algorithm not checked]; `pict-node` (MIT, 1.3.2, 2024-07-24, wrapper around PICT binary) [V]. No JS IPOG implementation found.

## 4. Clopper-Pearson, zero-failure bounds, rule of three
**Draft statement: correct** (all arithmetic checked).
**Exact form:** k successes in n trials, one-sided confidence 1-alpha. Lower L = BetaInv(alpha; k, n-k+1), L = 0 if k = 0. Upper U = BetaInv(1-alpha; k+1, n-k), U = 1 if k = n. BetaInv(q; a, b) = quantile of Beta(a,b). [M, standard; closed forms below derived]
- Zero failures: Beta(n,1) has CDF x^n, so L = alpha^(1/n). Need alpha^(1/n) >= q, i.e. n >= ln(alpha)/ln(q). q = 0.99, alpha = 0.05: 298.07 so n = 299; check 0.99^299 = 0.04954 <= 0.05 and 0.99^298 = 0.05004 > 0.05. [computed] Other cases: q=0.999 gives 2995; q=0.95 gives 59; q=0.99 with alpha=0.01 gives 459; q=0.9 gives 29. [computed]
- Rule of three: upper bound on failure probability with 0/n failures at 95% one-sided is 1 - 0.05^(1/n) = 2.996/n approx 3/n. Accurate for n >= ~30 (n=100: 0.0295 vs 0.030; n=30: 0.0950 vs 0.100; n=10: 0.259 vs 0.30). [computed] It is one-sided 95%; the two-sided 95% interval gives 3.69/n.
- Quantile claims: "the p-quantile of X is <= t" holds with confidence 1-alpha when you count observations <= t: Binomial(n, p) argument; with all n observations <= t you get n >= ln(alpha)/ln(p). Distribution-free. [M]
**Assumptions:** independent identically distributed Bernoulli trials (the system under test is a fixed distribution; no learning, no state carried between trials, no environment drift). A guided or adaptive test selection invalidates it.
**Source:** Clopper, Pearson. Biometrika 26(4), 1934 [M]. Hanley, Lippman-Hand. "If nothing goes wrong, is everything all right? Interpreting zero numerators." JAMA 249(13), 1983 [M].
**Limits:** conservative (coverage >= 1-alpha, not equal); one-sided vs two-sided must be stated; the BetaInv values were checked by the closed forms above, not numerically.
**Libraries:** JS: `@stdlib/math-base-special-betaincinv` (Apache-2.0 AND BSL-1.0, 0.2.3, 2026-02-08) [V]; `jstat` (MIT per repo LICENSE, 1.9.6, 2022-11-21; npm licence field empty) [V], `jStat.beta.inv` [M]. Rust: `statrs` (MIT) [M].

## 5. Wald's SPRT for a Bernoulli parameter
**Draft statement: correct.**
**Exact form:** H0: p = p0 vs H1: p = p1 (p1 != p0). After n trials with k successes, log LR = k ln(p1/p0) + (n-k) ln((1-p1)/(1-p0)). Continue while ln B < LLR < ln A, accept H1 when LLR >= ln A = ln((1-beta)/alpha), accept H0 when LLR <= ln B = ln(beta/(1-alpha)). alpha = P(accept H1 | H0), beta = P(accept H0 | H1). With alpha = beta = 0.05 the thresholds are +-2.944. [computed]
**Approximation involved:** A and B are Wald's approximations. They ignore the overshoot of the LLR over the boundary. The true error rates alpha', beta' satisfy alpha' <= alpha/(1-beta), beta' <= beta/(1-alpha), and alpha' + beta' <= alpha + beta. [M] Expected sample sizes are also approximations (Wald's equation).
**Assumptions:** i.i.d. Bernoulli, simple hypotheses, indifference region between p0 and p1; sample size random and unbounded (truncate in practice, which breaks the guarantee slightly).
**Source:** Wald. "Sequential tests of statistical hypotheses." Annals of Mathematical Statistics 16(2), 1945; Wald, Sequential Analysis, 1947 [M].
**Limits:** sensitive to a wrong p0/p1; not valid if trials are dependent or the policy changes mid-run.
**Libraries:** none needed.

## 6. Ochiai spectrum-based fault localization
**Draft statement: correct.**
**Exact form:** Ochiai(s) = ef / sqrt((ef + nf) * (ef + ep)), ef = failing tests that execute s, nf = failing tests that do not execute s, ep = passing tests that execute s. Abreu et al. write a11 / sqrt((a11 + a01)(a11 + a10)) with a11 = executed and failed, a10 = executed and passed, a01 = not executed and failed. Identical. [V]
**Source:** Abreu, Zoeteweij, van Gemund. "An Evaluation of Similarity Coefficients for Software Fault Localization." PRDC 2006, pp. 39-46, doi:10.1109/PRDC.2006.18 [V text, https://webarchive.di.uminho.pt/haslab.uminho.pt/ruimaranhao/files/azg_prdc06.pdf]. Also "On the Accuracy of Spectrum-based Fault Localization," TAIC PART 2007, and "A Practical Evaluation of Spectrum-based Fault Localization," JSS 2009 [S]. The coefficient comes from molecular biology (Ochiai 1957) [V].
**How well it works:** on the Siemens suite, Ochiai outperformed Tarantula, Jaccard and others, improving the code to inspect by 5% on average and up to 30% [S].
**Limits:** Parnin and Orso, "Are automated debugging techniques actually helping programmers?" ISSTA 2011 (not ICSE), pp. 199-209: a user study (34 developers per a slide summary [S]) found assumptions behind SBFL do not hold in practice (programmers did not find bugs faster with the tool; they do not follow ranked lists linearly; perfect bug understanding is not given). [S] Also results on real faults (Pearson et al., ICSE 2017) are much weaker than on seeded faults [M]. Coincidentally correct passing runs and statement-level granularity limit precision; it ranks, it does not explain.
**Libraries:** none needed.

## 7. Delta debugging (ddmin)
**Draft statement: imprecise** (the best case is conditional and is an upper bound).
**Exact form (verified in the paper text):**
- Input: failing test case c'_x with |c'_x| = n changes; ddmin splits into n_g subsets, tests each subset and each complement; if a failing one is found it recurses on it (n_g reset to max(n_g - 1, 2) for a complement, 2 for a subset); otherwise doubles granularity (n_g = min(2 n_g, |c|)) until granularity is |c|. Outcomes: fail (x), pass, unresolved (?). [V; algorithm in Section III-B]
- Proposition 12 (worst case): ddmin needs at most |c|^2 + 3|c| tests. [V]
- Proposition 13 (best case): if there is only one failure-inducing change and all test cases that include it fail, the number of tests is at most 2 log2 |c|. [V] So "about 2 log2 n" is a conditional upper bound, not a typical case; binary-search behaviour needs a structure of independent, monotone failing chunks.
- 1-minimal (Def. 10): removing any single change makes the failure disappear. ddmin returns a 1-minimal failing subset of the original failing input, not a global minimum. [V]
**Source:** Zeller, Hildebrandt. "Simplifying and Isolating Failure-Inducing Input." IEEE TSE 28(2), 2002, pp. 183-200. https://www.st.cs.uni-saarland.de/papers/tse2002/tse2002.pdf [V]
**Limits:** syntactically invalid inputs give unresolved outcomes (inflates test count, paper's own GCC example); needs a deterministic, fast test; flaky failures break the guarantee; for structured inputs use hierarchical delta debugging (Misherghi and Su, ICSE 2006) [M].
**Libraries:** no maintained TS/Rust ddmin library was identified [S]; the algorithm is about 40 lines.

## 8. LTL3 runtime verification and specification patterns
**Draft statement: LTL3 correct; Dwyer's statistic and pattern list imprecise or unverified.**
**LTL3:** for finite prefix u, [u |= phi] = true if every infinite extension sigma satisfies phi (u sigma |= phi); false if every extension violates it; inconclusive ("?") otherwise. [M, matches the TOSEM abstract: three truth values true, false, inconclusive for partial observations [S]]. The monitor is the smallest deterministic monitor that reaches a verdict as early as possible; monitorable properties are a strict superset of safety and co-safety. [S] Precursor: Arafat, Bauer, Leucker, Schallhart "Runtime verification revisited" TUM-I0724 (2005/2007) [S].
**Source:** Bauer, Leucker, Schallhart. "Runtime Verification for LTL and TLTL." ACM TOSEM 20(4), Article 14, 2011, doi:10.1145/2000799.2000800.
**Patterns (Dwyer, Avrunin, Corbett, ICSE 1999, pp. 411-420, doi:10.1145/302405.302672) [S]:** occurrence patterns: Absence, Universality, Existence, Bounded Existence; order patterns: Precedence, Response, Chain Precedence, Chain Response, and also Constrained Chain (the draft list omitted it) [S: citing paper lists "Bounded Existence, Precedence Chain, Response Chain, Constrained Chain" as the four additional]. Scopes: Global, Before R, After Q, Between Q and R, After Q Until R [S, confirmed by the Dwyer pattern site structure].
**Statistic:** the paper's abstract states that the vast majority (92%) of collected specifications are instances of the patterns [S]. The sample size is "over 500" in the secondary sources found; the figure 555 was not verified from a primary source.
**Limits:** LTL3 on finite traces gives "inconclusive" for liveness and for anything not yet violated; fairness cannot be monitored; for GUI/web traces, atomic propositions must be well defined and traces sampled at observation points.
**Libraries:** not researched (candidates: LTLf monitors, `rv-monitor`); none verified.

## 9. Linearizability checking
**Draft statement: correct** (with the notes below).
- Wing and Gong, "Testing and verifying concurrent objects," J. Parallel and Distributed Computing 17(1-2), 1993 [M]: depth-first search over linearization orders, backtracking.
- Lowe, "Testing for linearizability," Concurrency and Computation: Practice and Experience 29(4), 2017 [M]: memoisation of (set of linearized ops, model state) pairs (the "WGL" algorithm), plus a just-in-time variant.
- Horn and Kroening, "Faster linearizability checking via P-compositionality," FORTE 2015, pp. 50-65, arXiv:1504.00204 [S]: generalises Herlihy-Wing locality; split a history into independent sub-histories by a partition function; reported at least an order of magnitude faster than WGL.
- NP-completeness: Gibbons and Korach, "Testing shared memories," SIAM J. Computing 26(4), 1997 [M]; cited as [3] for NP-completeness of linearizability checking in Horn and Kroening [S]. The result concerns checking a given history against a sequential spec; it is polynomial for restricted cases (e.g. fixed number of processes for some types) [M].
**Libraries:** Porcupine (Go): MIT, tag v1.3.1, last commit 2026-09-21 [V]. Rust: Stateright `LinearizabilityTester` (MIT, crate 0.31.0, 2025-07-27) [V]. Rust `loom` is a model checker, not a history checker [V]. TS/JS: npm `@overkill-dev/linearizability` 0.0.4 (MIT, published 2026-11-16, "bounded concurrent-history checking") and `@systemfsoftware/conformance-spec` (Apache-2.0, Effect-specific) exist [S: npm search]; neither is established. Jepsen Knossos: EPL-1.0, version 0.3.17-SNAPSHOT, last commit 2026-07-17, not archived, no GitHub releases, described as "verifies the linearizability of experimentally accessible histories" [V project.clj and GitHub metadata]. No deprecation notice was found; claims that it is superseded were not verified.
**Limits:** worst case exponential; needs a deterministic sequential model and complete histories (indeterminate ops complicate it); checks a history, not the implementation.

## 10. Elle
**Draft statement: correct in outline; add the preconditions for soundness.**
**What it checks:** infers an Adya-style dependency graph (ww, wr, rw edges, plus process and real-time edges) between client-observed transactions, by choosing object types whose reads reveal version history (list-append is traceable; rw-register has weaker inference). It detects every anomaly in Adya et al.'s formalism except predicate anomalies. [V]
**Anomalies:** G0 = cycle made only of write-dependency edges; G1c = cycle with write- and read-dependency edges; G1a aborted read; G1b intermediate read; G-single (cycle with exactly one anti-dependency); G2 (cycle with anti-dependencies). [V for G0, G1c, G1a definitions in the paper; G1b, G-single, G2 [M]]. Elle also defines "dirty update" for non-register datatypes. [V]
**Soundness:** "if it reports an anomaly in an observation, that anomaly should exist in every interpretation of that observation" (no false positives); proved using traceability and recoverability of versions; completeness is relative (the more recoverable and the fewer indeterminate transactions, the more anomalies found). [V] Efficiency: linear-time claim is in the paper [M].
**Source:** Kingsbury, Alvaro. "Elle: Inferring Isolation Anomalies from Experimental Observations." arXiv:2003.10554 (23 Mar 2020) [V]; published at PVLDB 14(3), 2020 (VLDB) [M]. https://arxiv.org/abs/2003.10554
**Libraries:** `jepsen-io/elle`, Clojure, EPL-2.0 (README: or GPL-2.0 with classpath exception) [V]; no GitHub releases; last push 2026-10-16 [V]. No TS/Rust port identified.
**Limits:** only as strong as the workload (needs unique values/list-append); needs a faithful client history with indeterminate ops marked; no predicates; the real-time and process edges assume the clock/ordering information you record.

## 11. UCB1 and bandit scheduling
**Draft statement: correct.**
**Exact form [V, Theorem 1]:** play each arm once, then play the arm j maximising x_bar_j + sqrt(2 ln n / n_j), n = total plays so far, n_j = plays of arm j, x_bar_j = average reward. Rewards have support in [0,1]. Expected regret after any n plays (uniformly in n, finite time) is at most [8 * sum_{i: mu_i < mu*} (ln n / Delta_i)] + (1 + pi^2/3) * sum_{j=1..K} Delta_j, where Delta_i = mu* - mu_i. Needs stationary reward distributions, independent across plays.
**Source:** Auer, Cesa-Bianchi, Fischer. "Finite-time Analysis of the Multiarmed Bandit Problem." Machine Learning 47, 2002, pp. 235-256. https://homes.di.unimi.it/cesa-bianchi/Pubblicazioni/ml-02.pdf
**Fuzzing precedents:** AFLFast: Boehme, Pham, Roychoudhury, "Coverage-based Greybox Fuzzing as Markov Chain," CCS 2016 (power schedules from a Markov chain model of paths; not a bandit) [M]. Bandit framings: Wang, Song, Yin, "Reinforcement Learning-based Hierarchical Seed Scheduling for Greybox Fuzzing," NDSS 2021: models seed scheduling as a multi-armed bandit and adopts UCB1 over a hierarchical seed tree, with a "rareness" initial score because arms grow over time [V]. Yue et al., "EcoFuzz: Adaptive Energy-Saving Greybox Fuzzing as a Variant of the Adversarial Multi-Armed Bandit," USENIX Security 2020, pp. 2307-2324 [S].
**Limits:** fuzzing and crawling rewards are non-stationary and shrink as coverage saturates, so the UCB1 regret theorem does not apply as proved; the new-arm problem is acknowledged by the NDSS paper [V].
**Libraries:** none needed (5 lines).

## 12. Mutation analysis
**Draft statement: correct, with the exact wording of the cited findings below.**
- Mutation score = killed / (total - equivalent) [M]; deciding equivalence is undecidable (Budd and Angluin, Acta Informatica 1982) [M]; in practice use trivial compiler equivalence or treat unkilled as "survived".
- Competent programmer and coupling hypotheses: DeMillo, Lipton, Sayward, "Hints on test data selection: Help for the practicing programmer," IEEE Computer 11(4), 1978; Offutt, "Investigations of the software testing coupling effect," ACM TOSEM 1(1), 1992 [M].
- Subsumption / minimal mutant sets: Ammann, Delamaro, Offutt, "Establishing theoretical minimal sets of mutants," ICST 2014 [M].
- Just, Jalali, Inozemtseva, Ernst, Holmes, Fraser, "Are mutants a valid substitute for real faults in software testing?" FSE 2014, pp. 654-665: "73% of real faults are coupled to the mutants generated by commonly used mutation operators"; 17% not coupled; 10% need new or stronger operators; 357 real faults, 230,000 mutants [V for 73%, S for the rest]. Also: mutant detection correlates with real-fault detection independent of code coverage. https://cs.ubc.ca/~rtholmes/papers/fse_2014_just.pdf
- Papadakis, Shin, Yoo, Bae, "Are mutation scores correlated with real fault detection? A large scale empirical study on the relationship between mutants and real faults," ICSE 2018 (doi:10.1145/3180155.3180183): the correlation is weak once test suite size is controlled; mutants still give useful guidance [S].
- Inozemtseva, Holmes, "Coverage is not strongly correlated with test suite effectiveness," ICSE 2014: "a low to moderate correlation between coverage and effectiveness when the number of test cases in the suite is controlled for"; "stronger forms of coverage do not provide greater insight into the effectiveness of the suite"; effectiveness measured by mutant kill; moderate to high correlation when suite size is ignored. [V] https://www.cs.ubc.ca/~rtholmes/papers/icse_2014_inozemtseva.pdf
**Limits:** operator choice, equivalent and redundant mutants inflate/deflate score, cost (full mutation is expensive; use sampling or selective operators).
**Libraries:** Stryker Mutator (JS/TS, Apache-2.0) and cargo-mutants (Rust, MIT) [M, not checked].

## 13. Regression test selection
**Draft statement: correct.**
- Safe selection (Rothermel and Harrold, "A Safe, Efficient Regression Test Selection Technique," ACM TOSEM 6(2), 1997, pp. 173-210, doi:10.1145/248233.248262): under stated conditions, the technique selects every test from the original suite that can expose faults in the modified program (does not omit any fault-revealing test). It may select tests that cannot expose faults (imprecise but safe). [S] The conditions are the "controlled regression testing" assumption (same environment, specifications and test inputs, only the code changes; tests deterministic) from their TSE 1996 framework "Analyzing regression test selection techniques" [M; the phrase was not confirmed].
- Modern test impact analysis: dynamic or static dependency tracking from test to code (Ekstazi, ISSTA 2015 [M]); not proven safe when dependencies are reflection, config, data files or environment.
- Predictive test selection: Machalica, Samylkin, Porth, Chandra, ICSE-SEIP 2019: ML model learned from historical test outcomes; halves infrastructure cost while still reporting over 95% of individual test failures and over 99.9% of faulty changes [S]. This is probabilistic, not safe. arXiv:1810.05286.
**Limits:** flaky tests and nondeterminism void safety; PTS needs history (cold start) and cannot give a guarantee beyond measured recall.

## 14. The oracle problem
**Draft statement: correct.**
**Exact:** Barr et al. classify work on test oracles into four categories: **specified test oracles**, **derived test oracles**, **implicit test oracles**, and **no test oracle** (handling the lack of an automated test oracle, e.g. human oracles and crowd-sourcing). [V, Section 2 of the paper] Derived oracles include metamorphic relations, regression suites, N-version/pseudo-oracles. [V]
**Source:** Barr, Harman, McMinn, Shahbaz, Yoo. "The Oracle Problem in Software Testing: A Survey." IEEE TSE 41(5), 2015, pp. 507-525. https://earlbarr.com/publications/testoracles.pdf

## 15. Metamorphic testing
**Draft statement: correct (definition below).**
**Definition:** a metamorphic relation (MR) is a necessary property relating the inputs and outputs of multiple executions of the program, for example f(x) = f(g(x)) or "adding an irrelevant record leaves the result set unchanged". From a source input x and its output, generate a follow-up input, and check the relation holds; a violation reveals a fault without a reference oracle. [M]
**Sources:** Chen, Cheung, Yiu, "Metamorphic testing: a new approach for generating next test cases," HKUST-CS98-01, 1998 [M]. Segura, Fraser, Sanchez, Ruiz-Cortes, "A Survey on Metamorphic Testing," IEEE TSE 42(9), 2016 [M]. Chen et al., "Metamorphic Testing: A Review of Challenges and Opportunities," ACM Computing Surveys 51(1), 2018 [M].
**Limits:** MRs are necessary, not sufficient (passing does not prove correctness); finding good MRs needs domain knowledge; MRs can be satisfied by a wrong implementation.

## 16. Model-based testing conformance
**Draft statement: correct in outline.**
- ioco (Tretmans): implementation i conforms to specification s iff for every suspension trace sigma of s, out(i after sigma) is a subset of out(s after sigma). I.e. after any behaviour allowed by the spec, every output (including quiescence/absence of output) of the implementation is allowed by the spec; inputs are not constrained (inputs are assumed always enabled). [M] Source: Tretmans, "Test generation with inputs, outputs and repetitive quiescence," Software, Concepts and Tools 17(3), 1996; "Model based testing with labelled transition systems," 2008 [M].
- Transition tour: Naito and Tsunoyama, "Fault detection for sequential machines by transition tours," FTCS-11, 1981 [M]. The shortest tour traversing every transition at least once is a (directed) Chinese Postman tour (Edmonds and Johnson 1973 [M]; protocol-testing use: Aho et al. 1991 [M]); requires the transition graph to be strongly connected.
- Weakness: it checks output faults on each traversed transition but does not verify the state reached, so transfer (tail-state) faults can escape; the W-method (Chow, "Testing software design modeled by finite-state machines," IEEE TSE 4(3), 1978) appends characterisation-set sequences W to verify states, and requires an upper bound m on the number of states of the implementation; suite size grows exponentially in m - n [M].

## 17. Assurance cases
**Draft statement: correct on the notation; check the standards claims.**
- GSN Community Standard, Version 3, published by the Assurance Case Working Group (ACWG) of the Safety-Critical Systems Club (SCSC), 4 May 2021 [S: scsc.uk listing, https://scsc.uk/r1386.pdf]. Document code "SCSC-141C" unverified. Version 1 was 2011 (GSN User Community WG) [S].
- Elements: Goal, Strategy, Solution (evidence), Context, Assumption, Justification [M]; Version 3 adds modular and assurance-claim-point extensions [M, low confidence].
- OMG SACM: latest formal version 2.3 (adopted October 2023); 2.4 is a beta dated September 2026 [V, omg.org/spec/SACM]. 2.1 adopted April 2020, 2.0 March 2018 [S].
- Which standards require a safety/assurance case [S and M]:
  - ISO 26262:2018: yes, a "safety case" is a required work product in Part 2, with guidance in Part 10 [S].
  - UL 4600: yes, the standard is organised around a safety case (structured argument supported by evidence) for autonomous products [S].
  - IEC 61508: does not name an assurance/safety case as a mandated artefact; it requires safety lifecycle documentation and functional safety assessment, and the term is used by national practice (e.g. UK) [M, not verified].
  - DO-178C: does not require an assurance case; it prescribes objectives per software level and plans/summary documents (e.g. Software Accomplishment Summary) [M, not verified].
**Limits:** the argument is only as sound as its evidence and assumptions (confirmation bias, "eliminative" defeaters are discussed in the assurance literature [M]).

## 18. Playwright coverage and Clock
**Draft statement: correct.**
- Version: playwright 1.65.1, Apache-2.0, published 2026-11-13 [V npm].
- `page.coverage` (class Coverage, since v1.11) [V]: `startJSCoverage({resetOnNavigation?: boolean = true, reportAnonymousScripts?: boolean = false})`, `stopJSCoverage()`, `startCSSCoverage({resetOnNavigation = true})`, `stopCSSCoverage()`. Docs: "Coverage APIs are only supported on Chromium-based browsers." `resetOnNavigation: false` is marked discouraged and "does not guarantee that coverage persists through navigations". [V]
- JS result: array of `{url, scriptId, source?, functions: [{functionName, isBlockCoverage, ranges: [{count, startOffset, endOffset}]}]}` (V8 format). CSS result: `{url, text?, ranges: [{start, end}]}`, sorted, non-overlapping. [V]
- Block-level: Playwright calls `Profiler.startPreciseCoverage({callCount: true, detailed: true})` [V, crCoverage.ts source], so V8 returns block ranges with execution counts (`isBlockCoverage` true), not just function counts. V8 reports ranges whose count differs from the enclosing block; branch (if/else) pairs are reconstructed by converters such as v8-to-istanbul, so branch coverage is approximate versus instrumented Istanbul output [M].
- `page.clock` [V]: `install({time?})`, `fastForward(ticks)` (jumps the clock, firing due timers at most once), `runFor(ticks)` (advances and fires every callback on the way), `pauseAt(time)`, `resume()`, `setFixedTime(time)` (fixes Date.now/new Date(), timers keep running), `setSystemTime(time)` (changes system time without firing timers). It fakes Date, timers, animation frames and performance.
- Licences: `v8-to-istanbul` ISC, 9.3.0, 2024-06-22 [V]; `monocart-coverage-reports` MIT, 3.2.1, 2026-11-08 [V].
**Limits:** Chromium only; source maps needed for TypeScript; coverage resets on navigation by default; anonymous scripts (eval, inline) off by default.

## 19. Bounded and exhaustive methods
**Small scope hypothesis:** most bugs have small counterexamples (Jackson, "Software Abstractions," MIT Press, 2006 [M]); Andoni, Daniliuc, Khurshid, Marinov, "Evaluating the 'Small Scope Hypothesis'," MIT CSAIL technical report, 2003 [M; the primary report was not retrieved]. It is empirical, not a theorem.

| Tool | Licence | Latest | What it returns |
|---|---|---|---|
| TLC (tlaplus) | MIT [V] | v1.7.4 (2024-08-05), repo active | exhaustive over the finite state graph (complete if the state space is finite and fully explored); error trace for a violated invariant/property; simulation mode is random sampling, no guarantee [M] |
| Apalache | Apache-2.0 [V] | v0.63.0 (2026-11-10) | symbolic bounded checking to length k ("holds up to k steps"), or inductive-invariant check (a proof when it passes); counterexample trace [M] |
| Alloy | repo LICENSE says "currently MIT", Apache-2.0 text staged [V] | v6.2.0 (2025-01-09) | instance/counterexample within a stated scope; "no counterexample" is only valid within the scope |
| CBMC | BSD-4-Clause (advertising clause present) [V] | 6.11.0 (2026-08-21) | bounded model check with `--unwind`; unwinding assertions show if the bound is sufficient (then it is a proof for all inputs in the harness); counterexample trace [M] |
| Kani (Rust) | Apache-2.0 OR MIT (crate); GitHub shows Apache-2.0 [V] | 0.68.0 (2026-09-16) | per-harness SUCCESSFUL/FAILED with loop-unwinding bound; concrete playback test for failures [M] |

Evidence to record: result (holds / violated), bound (scope, depth, unwind), tool version, model hash, counterexample trace. Never record "verified" without the bound.

## 20. MC/DC
**Draft statement: correct.**
Definition (Chilenski, Miller, "Applicability of modified condition/decision coverage to software testing," Software Engineering Journal 9(5), 1994) [M]: every point of entry and exit has been invoked, every condition in a decision has taken all possible outcomes, every decision has taken all possible outcomes, and each condition has been shown to independently affect the decision's outcome (varying only that condition flips the decision). DO-178C requires MC/DC for software level A (Table A-7); decision coverage for levels A and B, statement coverage for A, B, C [M, not re-verified]. N+1 tests are the minimum for N conditions (unique-cause); masking MC/DC is an accepted variant [M].

## 21. Systematic fault injection
**Draft statement: correct.**
- LDFI: Alvaro, Rosen, Hellerstein, "Lineage-driven fault injection," SIGMOD 2015 [M]. Idea: start from a successful execution, take the lineage (provenance) of the good outcome, compute with a SAT solver the minimal sets of faults (message losses, crashes, within given bounds) that would falsify every derivation, inject them, and repeat; each failed outcome is a bug, and if no fault set remains the outcome is robust under the stated fault bounds.
- FATE and DESTINI, Gunawi et al., NSDI 2011 [V]. A failure ID = an I/O ID plus the injected failure type (crash, etc.), hashed and recorded. I/O ID fields: static (function call, source file and line), dynamic (stack trace, node id), domain-specific (source/destination node, network message). A pair of failure IDs is "dependent" if the second is observed only after the first is injected. Combinations explode (45 failure IDs gave 1199 two-failure combinations in their append-protocol example), so FATE prioritises by recovery-behaviour clustering. [V]
- Jepsen "nemesis": the fault-injection process (partitions, kills, clock skew) run concurrently with the workload on randomised schedules; no coverage denominator. [M]
**Which gives a defensible denominator:** FATE failure IDs. Denominator = set of failure IDs (I/O point x failure mode) observed in a fault-free baseline run, widened with dependent IDs seen only after injections. State this as "N of M observed failure IDs"; the denominator grows during exploration, so a static enumeration of call sites is only an upper bound containing unreachable points. "Every I/O point failed once in each mode" is a legitimate coverage claim over that denominator, not a proof of fault tolerance.

## 22. fast-check and proptest-state-machine
- fast-check 4.10.2, MIT, published 2026-09-19 [V]. Model-based API: `fc.commands(arrayOfCommandArbitraries, options?)`, `fc.modelRun(setup, cmds)`, `fc.asyncModelRun(setup, cmds)`, `fc.scheduledModelRun(...)` (async with a scheduler, to find races) [V]. Commands implement `check(model)`, `run(model, real)`, `toString()` [V]. Shrinking: `commands` shrinks better than a plain array because it tracks which commands actually ran (e.g. `[A,B,C,A,A,C]` with only `[A,-,C,A,-,-]` executed shrinks to `[A,C,A]`); `replayPath` replays without re-running intermediate steps. [V]
- Rust: `proptest-state-machine` 0.9.0, MIT OR Apache-2.0, 2026-10-10 (proptest 1.12.0) [V]; API names (`ReferenceStateMachine`, `StateMachineTest`, `prop_state_machine!`) [M].

## 23. Model abstraction refinement for GUI exploration
**APE:** Gu, Sun, Ma, Cao, Xu, Yao, Zhang, Lu, Su, "Practical GUI Testing of Android Applications via Model Abstraction and Refinement," ICSE 2019, pp. 269-280 [S for citation]. Idea: build a model of the app (abstract states and transitions) whose abstraction function (how concrete GUI trees map to abstract states) is not fixed: start coarse, and refine it at runtime (splitting abstract states by more GUI attributes) when the model shows nondeterminism or when exploration stalls, then reduce/merge to keep the model compact; guided by the model (action selection by exploration and exploitation). The abstraction is a decision tree over attribute paths ("naming") [M; repo has `Naming.java`, `Name.java`, `Namer.java`, `NamingFactory.java` [V]]. The decision-tree detail and the refine-on-nondeterminism trigger were not confirmed. Reported: beat prior tools on coverage and unique crashes on 15 popular apps [S]. Repo `tianxiaogu/ape`: Apache-2.0 [V].
**Crawljax:** Mesbah, van Deursen, Lenselink, "Crawling Ajax-based Web Applications through Dynamic Analysis of User Interface State Changes," ACM TWEB 6(1), 2012 [M]; state = DOM after an event, equivalence through pluggable comparators and DOM normalisation (a fixed abstraction, no refinement) [M]. Apache-2.0, crawljax-5.2.3 (2023-06-01), last push 2023-09-18 [V].

## 24. Playwright actionability and networkidle
**Actionability (docs list six checks)** [V]: **Visible** (non-empty bounding box and no `visibility:hidden`; `opacity:0` counts as visible), **Stable** (same bounding box for at least two consecutive animation frames), **Receives Events** (the element is the hit target at the action point), **Enabled**, **Editable** (enabled and not readonly), **Not Inert** (not within an `inert` subtree). "Attached" is an assertion (`toBeAttached`), not an actionability check.
Per action [V]: click/dblclick/check/uncheck/setChecked/tap need Visible + Stable + Receives Events + Enabled + Not Inert; hover and dragTo need Visible + Stable + Receives Events; fill and clear need Visible + Enabled + Editable + Not Inert; selectOption needs Visible + Enabled + Not Inert; screenshot needs Visible + Stable; scrollIntoViewIfNeeded needs Stable; focus, press, dispatchEvent, setInputFiles etc. need none.
**networkidle** [V]: the operation is finished when there are no network connections for at least 500 ms. The docs label it DISCOURAGED: "Don't use this method for testing, rely on web assertions to assess readiness instead." Reasons ([M]): long-lived connections (websockets, polling, analytics) never go idle; idle network does not mean the UI has rendered or timers have fired; the 500 ms window is a heuristic that races with client rendering.

## 25. Hyperproperties
**Draft statement: the definition is fine; "noninterference is a 2-safety hyperproperty" is imprecise.**
**Exact [V, Clarkson and Schneider]:** a trace property is a set of infinite traces; a hyperproperty is a set of trace properties (a set of sets of traces); a system satisfies it if the system's set of traces is a member. A safety hyperproperty (hypersafety) has a finite set M of finite observations as the "bad thing"; **k-safety** adds |M| <= k (the violation is shown by at most k finite traces). Hypersafety is subset closed.
**Noninterference:** Goguen-Meseguer noninterference (their GMNI, eq. 2.4) and McLean's generalised noninterference (GNI, eq. 2.5) are hyperproperties but not trace properties; GNI is not subset closed, so it is not hypersafety at all (it needs an existential third trace). **Observational determinism is a 2-safety hyperproperty** [V]. Termination-insensitive relational noninterference is hypersafety (bad thing = a pair of traces with low-equivalent starts and non-equivalent finals), i.e. 2-safety; termination-sensitive noninterference is neither hypersafety nor hyperliveness [V]. Terauchi and Aiken's "2-safety" is a stricter subset (deterministic, relational model).
**Correct statement:** "Noninterference-style properties are hyperproperties; the termination-insensitive, deterministic form and observational determinism are 2-safety."
**"One user cannot read another's data":** if defined by what user B can observe not varying with user A's secrets (for all pairs of executions that agree on B's inputs, B's outputs agree) it is a relational, 2-safety hyperproperty, testable by running pairs. If instead you tag data with an owner and assert "no event delivers A-tagged data to B", it is an ordinary trace (safety) property on a single run. A check has to say which of the two it is.
**Source:** Clarkson, Schneider. "Hyperproperties." Journal of Computer Security 18(6), 2010, pp. 1157-1210, doi:10.3233/JCS-2009-0393 (earlier CSF 2008). https://www.cs.cornell.edu/fbs/publications/Hyperproperties.pdf

---

## Summary table

| # | Verdict | One-line correction |
|---|---|---|
| 1 | correct | Define n = max threads, k = max steps (sync ops if optimised), d = min ordering constraints; bound is worst-case and tight; applies to scheduled threads, only analogically to async/distributed |
| 2 | imprecise | Good-Turing f1/n correct; Chao1 is a lower bound and its bias-corrected form has an (n-1)/n factor and f1(f1-1)/2 when f2=0; blackbox estimators under-estimate in adaptive (greybox) sampling |
| 3 | imprecise | Table is cumulative: 2-way 62-97% (53% seeded), 3-way 87-99% (74% seeded), 6-way 100% in all six studies; NIST says "all or nearly all failures involve 1 to 6 factors" |
| 4 | correct | n >= 299 checked; rule of three is the -ln(0.05)/n = 2.996/n approximation, loose for n < 30; assumes iid |
| 5 | correct | A and B are Wald approximations; true errors bounded by alpha/(1-beta), beta/(1-alpha) |
| 6 | correct | Formula matches Abreu et al. (PRDC 2006); Parnin and Orso is ISSTA 2011 |
| 7 | imprecise | Best case is conditional (single failure-inducing change, monotone) and is an upper bound of 2 log2 n; worst case n^2 + 3n and 1-minimality confirmed |
| 8 | imprecise | LTL3 correct; Dwyer list also has Constrained Chain; "over 500" specs and 92% (555 not verifiable here) |
| 9 | correct | Lowe's version is the WGL memoised algorithm; Knossos is EPL-1.0, not archived, no release; Porcupine MIT |
| 10 | correct | Soundness holds under traceable/recoverable datatypes; EPL-2.0; no predicate anomalies |
| 11 | correct | Theorem 1: regret <= 8 sum(ln n/Delta_i) + (1+pi^2/3) sum Delta_j, rewards in [0,1]; RLHSS (NDSS 2021) uses UCB1, AFLFast is Markov chain not bandit |
| 12 | correct | Just 73% coupled; Inozemtseva: low-to-moderate correlation when size controlled; Papadakis: weak when size controlled |
| 13 | correct | Safe means no fault-revealing test omitted under controlled-regression-testing conditions; PTS is probabilistic |
| 14 | correct | specified, derived, implicit, no test oracle |
| 15 | correct | MR = relation across multiple executions' inputs and outputs |
| 16 | correct | ioco/transition tour/W-method as stated; W-method needs state-count bound |
| 17 | correct (check) | GSN v3 (ACWG/SCSC, 2021); SACM 2.3 adopted Oct 2023 (2.4 beta); ISO 26262 and UL 4600 require a safety case; IEC 61508 and DO-178C do not [M] |
| 18 | correct | Chromium only; precise coverage with callCount+detailed gives block ranges; clock methods incl. pauseAt/resume/setSystemTime |
| 19 | correct | Licences: TLC MIT, Apalache Apache-2.0, Alloy MIT (Apache pending), CBMC BSD-4-Clause, Kani Apache-2.0/MIT; record the bound with the result |
| 20 | correct | MC/DC for DO-178C Level A [M] |
| 21 | correct | FATE failure ID = I/O ID + failure type; denominator = observed failure IDs, grows with dependent IDs |
| 22 | correct | fc.commands, modelRun, asyncModelRun, scheduledModelRun; fast-check 4.10.2 MIT |
| 23 | not checkable fully | APE decision-tree abstraction and refinement trigger unverified |
| 24 | imprecise | Six checks incl. Not Inert; networkidle = no connections for 500 ms and is DISCOURAGED |
| 25 | imprecise | Noninterference is a hyperproperty; only observational determinism and termination-insensitive relational NI are 2-safety; GNI is not hypersafety |

## Not verified
Gibbons-Korach, Lowe, Wing-Gong details; Dwyer 555 figure; Andoni et al. report; DO-178C Level A MC/DC and the IEC 61508 and DO-178C "no safety case" statements; APE decision tree; Elle venue (PVLDB 14(3)); Chao1 alternative bias-corrected formula; GSN code SCSC-141C; Knossos supersession; Stryker and cargo-mutants licences; BetaInv numerics (no scipy).
