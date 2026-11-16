# Every effect passes one gate

ADR 0002 fixed what Miqyas may do to a target, but the code enforced it by convention: host checks at half a dozen call
sites, probes with their own `fetch`, and a model-call gate that each provider had to remember to call. That holds for
one surface and thirteen checks. It doesn't hold for more surfaces and an agent team. So everything Miqyas does to a
target, and everything it lets out of the machine, is an effect, and every effect passes one gate. The gate decides from
two things, the class of the effect and the class of the environment, and hands a collector a capability scoped to what
it allowed. Nothing else can reach a target, a model, a tool or the network, and an agent holds no capability at all.

Effects on a target, lowest first:

- **observe**: load and read what a client is served, and move through the interface without submitting or destroying
  anything.
- **interact**: use the product through its own interface the way a person's plan says, submissions included.
- **probe**: send a request the interface wouldn't send, that only reads.
- **write**: send one that changes stored state or spends the target's money.
- **disrupt**: break or degrade the target on purpose (faults, restarts, clock skew, a mutated build).

Environments:

- **sandbox**: a target Miqyas started itself for this run and can throw away.
- **test host** and **owned host**: as ADR 0002 defines them.
- any other host.

| | sandbox | test host | owned host | any other host |
|---|---|---|---|---|
| observe | yes | yes | yes | yes |
| interact, from a person's plan | yes | yes | yes | yes |
| probe | yes | `--active` | `--active` | never |
| write | yes | `--active` | `--active --allow-writes` | never |
| disrupt | yes | `--allow-disrupt` | `--allow-disrupt` | never |

In a sandbox an agent may propose any effect, and code still carries it out through the gate. Everywhere else an agent
only picks from a list that code built, and interaction that code or an agent chooses (the crawl) stays at observe.

This extends ADR 0002. Its consent rules and its never-do list stand, and the list gains one line: never write to or
disrupt a live physical process, whatever the flags and whoever owns it.

## Considered options

- A policy module per surface: rejected. The rule that matters most would be written once per surface and forgotten in
  one of them.
- Keep classifying by feature (the crawl, an active check): rejected. Fault injection, a write probe in a throwaway
  copy and a read from a factory controller have no place in that scheme.
- Give agents a capability on test hosts: rejected. A page can address the agent (ADR 0002), so what an agent may do
  on a shared host has to be something code already decided was safe.

## Consequences

- Every decision of the gate is a record in the ledger, so a bundle shows everything Miqyas did to a target, allowed
  or refused.
- An active check is now any check that needs probe or higher.
- Model calls, tool runs and network fetches pass the same gate. ADR 0001's cap and ADR 0003's scrub and payload log
  become gate rules, so a new provider or adapter can't forget them.
- A worker that runs as its own process is held to the gate by a proxy it must send its traffic through, or it gets
  nothing above observe.
- The sandbox is where the strongest checks run at no risk: the mutation self-check, fault injection, write probes.
  The best proof of a build is a sandbox run on that exact build.
