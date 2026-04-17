/**
 * Workflow modes — opinionated "rails" layered on top of the default harness.
 *
 * The default fineCode philosophy is "let the model decide" (harness > framework).
 * But some users want stronger guardrails:
 *   - DDD: Domain-Driven Design — force modeling before coding
 *   - TDD: Test-Driven Development — force a failing test before implementation
 *   - SDD: Spec-Driven Development — force a spec/plan before changes
 *
 * Each mode is just an additional block prepended to the system prompt.
 * The model sees them alongside the normal tool instructions and can still use
 * all its tools — the difference is what "good behavior" is defined as.
 *
 * Toggle with `/mode ddd|tdd|sdd|none`. The Session meta persists the active
 * mode so resume keeps it on.
 */

export type WorkflowMode = 'none' | 'ddd' | 'tdd' | 'sdd';

export const MODE_DESCRIPTIONS: Record<WorkflowMode, string> = {
  none: 'Default harness — model decides the approach.',
  ddd: 'Domain-Driven Design: model the domain before coding.',
  tdd: 'Test-Driven Development: failing test → code → green.',
  sdd: 'Spec-Driven Development: spec/plan → code → verify.',
};

const DDD_PROMPT = `
# Workflow: Domain-Driven Design (DDD)

You are in DDD mode. Before writing any implementation code, you MUST:

1. **Identify the bounded context** — which part of the domain does this touch?
2. **Name the entities, value objects, aggregates, and domain services** involved.
3. **Describe the domain behavior in plain domain language** — no technical jargon, no framework names.
4. **Propose the ubiquitous language** — the exact nouns and verbs that will appear in code.
5. **Only after the above is agreed, start implementing**.

Produce a short DDD sketch using \`todo_write\` or a markdown code block before any \`edit_file\` / \`write_file\` call. If the user pushes back on the model, revise the model FIRST, not the code.

Avoid anemic domain models: behavior belongs on the aggregate, not on a service class.`.trim();

const TDD_PROMPT = `
# Workflow: Test-Driven Development (TDD)

You are in TDD mode. Follow Red-Green-Refactor strictly:

1. **Red** — write a failing test that expresses the desired behavior. Run the tests and confirm it fails for the RIGHT reason (the code under test doesn't exist or doesn't return the expected value), not because of a setup mistake.
2. **Green** — write the minimum code to make that test pass. Resist the urge to add extra features.
3. **Refactor** — with the test green, tidy the code. Run tests after each tidy step.

Rules:
- Never write production code without a failing test justifying it.
- Never write more test than needed to force a failure.
- Never write more production code than needed to pass the current failing test.
- Commit (or offer to commit) after each green.

If the user asks for a feature, your FIRST tool call should be to create or locate the test file, not the implementation file.`.trim();

const SDD_PROMPT = `
# Workflow: Spec-Driven Development (SDD)

You are in SDD mode. Before writing code, you MUST:

1. **Produce a spec** — a short, numbered list of requirements the final change must satisfy. Include input/output shapes, error cases, and invariants.
2. **Produce a plan** — a sequence of concrete steps (which files will change, in what order, and why). Use \`todo_write\` for the plan so progress is visible.
3. **Get user approval** — pause and ask the user to confirm the spec and plan before any destructive tool call (write_file, edit_file, bash).
4. **Execute the plan** — mark each step in_progress / completed as you go.
5. **Verify against the spec** — after implementation, quote each requirement from the spec and show concretely how the change satisfies it.

Rules:
- If the user changes their mind mid-task, regenerate the spec and plan before changing code.
- If you discover a requirement that wasn't in the spec, STOP, ask, and update the spec before proceeding.`.trim();

export function promptForMode(mode: WorkflowMode): string | null {
  switch (mode) {
    case 'ddd':
      return DDD_PROMPT;
    case 'tdd':
      return TDD_PROMPT;
    case 'sdd':
      return SDD_PROMPT;
    case 'none':
    default:
      return null;
  }
}

/**
 * Combine the base prompt (built by buildSystemPrompt) with the mode prompt.
 * The mode block goes AFTER the core prompt but BEFORE environment info, so
 * the model reads the mode constraints before getting distracted by env.
 */
export function applyMode(basePrompt: string, mode: WorkflowMode): string {
  const extra = promptForMode(mode);
  if (!extra) return basePrompt;
  // Insert the mode block right after the core-prompt header — before "# Environment".
  const marker = '# Environment';
  const idx = basePrompt.indexOf(marker);
  if (idx === -1) return `${basePrompt}\n\n${extra}\n`;
  return `${basePrompt.slice(0, idx)}${extra}\n\n${basePrompt.slice(idx)}`;
}
