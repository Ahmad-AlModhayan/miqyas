# Experiments run from restorable state, and the engine checks that it is the same

An experiment compares two runs, which means nothing unless both started from the same state, and running one must
not spoil the state for the next. So restorable state is part of Miqyas's core. A capsule is a capture of what a
sandboxed target holds, which can be restored or forked. Each kind of stack has a recipe that says how to start it,
which stores of state it keeps (database, sessions, cache, queue, files, clock) and what happens to each on a
capture. The engine doesn't take a recipe's word: before any experiment it captures, restores, replays a recorded
sequence of reads, and compares. If the restored target doesn't answer as the original did, every experiment on it is
"can't tell".

Recipes come in levels behind one interface. The first captures a database, the browser's storage and what the recipe
lists besides, on any machine with containers. Later levels capture a process tree and then a whole virtual machine,
and need Linux.

## Considered options

- Start from exact replay of the whole machine: rejected as the first step. It is the strongest substrate and the
  longest to build. The interface is designed so that it can be reached without changing what is built on it.
- Trust a database copy to be "the same state": rejected. Sessions made at start-up, caches, queues, files, other
  services and time all sit outside it, and each makes a different kind of wrong answer: a restart that invalidates
  every session turns access defects into refusals.
- Run the experiments against a live host: allowed only as far as the gate allows (ADR 0008), which for anything that
  changes state is never without consent.

## Consequences

- What an action did becomes a measurement, its footprint: rows changed by table and column, matched by natural key
  with generated values left out, and the requests it sent. A footprint covers only the stores its recipe captures. It
  may raise the class the gate gives a request and never lower it.
- A capsule holds sandbox data only, lives in a store beside the run, is named in the ledger by digest, and is
  deleted when the run ends unless a person keeps it.
- Forks run side by side only where the recipe says no store is shared.
- A target whose backend is a hosted service runs against that service's local stack where one exists. Where none
  does, most axes can't be tested, and the report says so.
- Bringing a target to a state where a law has something to test (two accounts, each owning one of everything) is a
  search of its own, with an archive of states to return to.
- Recipes are a large part of the work, and restore times are targets until measured.
