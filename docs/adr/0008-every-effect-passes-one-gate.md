# Every effect passes one gate

ADR 0002 fixed what Miqyas may do to a target, but the code enforced it by convention: host checks at half a dozen call
sites, probes with their own `fetch`, and a model-call gate that each provider had to remember to call. That holds for
one surface and thirteen checks. It doesn't hold for more surfaces and an agent team. So everything Miqyas does to a
target, and everything it lets out of the machine, is an effect, and every effect passes one gate. The gate decides
from two things, the class of the effect and the class of the origin it lands on, and it works both out itself, at the
wire, for each request. It hands a collector a permit for what it allowed. Nothing else can reach a target, a model, a
tool or the network, and an agent holds no permit at all.

Effects, lowest first:

- **observe**: load and read what a client is served, and move through the interface without changing anything.
- **interact**: use the product through its own interface the way a person's plan says, submissions included.
- **probe**: send a request the interface didn't send, that only reads.
- **write**: send a request that changes stored state or spends the target's money.
- **disrupt**: break or degrade the target on purpose (faults, restarts, clock skew, a mutated build, load).
- **execute**: run the target's own code on this machine.

A class of environment belongs to an origin, not to a run:

- **sandbox**: the engine started the process serving it in this run, and that process reaches the network only
  through the gate.
- **test host** and **owned host**: as the threat model defines them. A test host on this machine is local; one known
  only by a label in a public name is named.
- **backend**: an origin the target's own pages call. It takes its consent from the origin that calls it.
- any other origin.

| | sandbox | local test host | named test host | owned host | backend | other |
|---|---|---|---|---|---|---|
| observe | yes | yes | yes | yes | yes | yes |
| interact, from a person's plan | yes | yes | yes | yes | through the page | yes |
| probe | yes | `--active` | `--active` | `--active` | as the origin that calls it | never |
| write | yes | `--active` | `--active --allow-writes` and the token | `--active --allow-writes` | as the origin that calls it, and `--allow-writes` | never |
| disrupt | yes | `--allow-disrupt` | `--allow-disrupt` and the token | `--allow-disrupt` | never | never |

`execute` runs in a container the engine started, with no network and a read-only copy of the repository, or with the
person's `--allow-exec`.

This extends ADR 0002 and changes it in three stated places. It amends ADRs 0001 and 0002 in one: in a sandbox a model
may propose an effect that code didn't list, and code still carries it out through the gate; everywhere else a model
only picks from a list code built, and interaction that code or an agent chooses stays at observe. It tightens one
rule: a named test host needs the ownership token before Miqyas writes to it or disrupts it, because a name proves
nothing about who owns it. And the never-do list, which stays in the threat model, gains a line: never write to or
disrupt a live physical process, whatever the flags and whoever owns it. The limits on Miqyas's own probes (inert
markers, a second account that only reads, only ids the test accounts own) stand, as deny rules.

## Considered options

- A policy module per surface: rejected. The rule that matters most would be written once per surface and forgotten in
  one of them.
- Take the class from the caller, checked against a table: rejected. A click that looks like a read can fire a request
  that deletes, and a `GET` can spend money. The gate classes each request from the request: an unsafe method is a
  write unless it matches a read pattern the gate knows, a route recorded as spending is a write, and a request the
  page never sent is at least a probe. A caller can raise the class and never lower it.
- One class of environment for the whole run: rejected. A build served locally can point at a production backend, and
  "everything is allowed in a sandbox" would then reach production.
- Give agents a permit on test hosts: rejected. A page can address the agent (ADR 0002), so what an agent may do on a
  shared host has to be something code already decided was safe.

## Consequences

- Every decision of the gate is a record in the ledger, so a bundle shows everything Miqyas did to a target, allowed
  or refused.
- The crawl is read-only at the wire: a request the page tries to send during it that would be a write is refused
  before it leaves, and the control is recorded as not tried. Before, the crawl judged a control by its label.
- An active check is now any check that needs probe or higher, outside a sandbox.
- Model calls, tool runs and network fetches pass the same gate. ADR 0001's cap and ADR 0003's scrub and payload log
  become gate rules, so a new provider or adapter can't forget them.
- A worker that runs as its own process is held to the gate by a proxy it must send its traffic through, or it gets
  nothing above observe.
- The gate can't know that a `GET` changes state on a badly built target. That is why anything above observe needs
  consent, and why the strongest checks (the mutation self-check, fault injection, write probes) run in a sandbox,
  where nothing is at risk. The best proof of a build is a sandbox run on that exact build.
