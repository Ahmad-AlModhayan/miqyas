# The engine is measured on real defects first, and on nothing from customers

A detector that scores its own findings can't be trusted on its scores, and one that improves on its users' code has
to take their code. Miqyas's engine is measured in the open, in this order. First, on defects that really happened:
published advisories for missing authorisation, wrong ownership checks and races in open-source applications, each
with the commit that fixed it. The engine runs on the commit before the fix, and either shows the defect or doesn't.
Second, on seeds planted for the purpose, where history is thin. A seed counts only if whoever planted it also wrote
a test that shows it without the engine. Anything fitted is fitted on some applications and reported on others.
Everything used is public or written for the purpose; no customer's code or data trains or tunes anything.

## Considered options

- Planted seeds as the main measure: rejected. A set made of "a guard removed from one route" mirrors what the engine
  was built to find, and says little about a guard that checks the wrong thing, a whole module done wrong, or a fault
  in shared configuration. Seeds whose admission depends on the engine being able to show them would count only what
  it already sees.
- Learn from what users mark as real or not: rejected. It needs users' findings to leave their machines (ADR 0003).
- Fit and report on the same applications: rejected. That measures memory.

## Consequences

- Numbers are published per axis and per kind of defect, never blended (ADR 0015), including "no experiment exists
  for this defect" as its own count.
- What the engine reports on an application judged clean is read by a person and labelled, under published rules,
  because a clean application is a real one and may hold real defects.
- Seeds a model writes are checked by code before they count, like every other proposal from a model, and the
  planting is confined to the public corpus by a rule of the gate.
- Until these measurements exist, the engine's scores are ranks and its claims are a design.
