# A surface is a vocabulary of facts, not a screen

The surface contract was a browser in disguise. An observation was a screenshot plus an accessibility tree, an action
was a click or a keystroke, and `miqyas-worker/1` copied that shape and let a worker return a verdict. No server,
command-line program, sync engine or factory controller fits it. A surface is now defined by the kinds of fact it can
record and the kinds of action it can take, each with a schema and an effect class: a snapshot of a rendered interface
for web, mobile and desktop; an HTTP exchange for an API; a process result for a command-line program; an operation
history and a fault log for an engine under test; a signal sample for a control system. A worker says which kinds it
speaks, a claim says which kinds it needs, and the engine matches the two. Workers speak `miqyas-worker/2`: JSON-RPC 2.0
as newline-delimited JSON, a `discover` call that returns versions and capabilities, evidence passed by digest, and no
verdict message.

The first two surfaces, web and API, are built together so that the contract is never shaped by one implementation.
The engine-scenario surface comes next, because it is the one least like a browser.

## Considered options

- One universal observation with optional fields per surface: rejected. Every claim would have to know which fields a
  surface fills, and the shape would keep growing toward the union of all of them.
- Make every worker a Model Context Protocol server: rejected as the core contract. Its results carry no digest, no
  provenance and no effect class, and its shape changed incompatibly twice in eighteen months. An MCP face can sit on
  top of a worker.
- Keep `miqyas-worker/1`: rejected. Nothing ran on it, and its verdict message contradicts ADR 0006.

## Consequences

- Web, mobile and desktop share one snapshot kind, so a plan's bindings and the Arabic and RTL rules carry across them.
- A worker can run inside the engine's process or as its own; the contract is the same either way.
- Anyone can add a surface by speaking the protocol, with no change to the engine.
- A new kind of fact is a schema with a version. Each kind says whether its content may go to a model; repository
  content never does (ADR 0003).
