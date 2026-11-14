/**
 * Prompts for the developer's own model.
 *
 * DIGEST_SYSTEM_PROMPT and RESOLUTION_SYSTEM_PROMPT are byte-stable constants
 * with no per-request data; everything that varies rides in the user message.
 * They are shared by all three providers.
 *
 * Prompt caching is deliberately NOT enabled (no `cache_control` marker): a
 * scan is typically one call per merged PR, which rarely reaches the ~4 calls
 * per 5 minutes needed to recoup the cache write, and the prompt is below the
 * 4,096-token minimum cacheable size of Opus 4.5+/Haiku 4.5. Revisit when
 * batched scans of large backlogs become common (see docs/roadmap.md).
 */
import type { Digest } from './schema.js';
import type { DigestInput, FeedbackItem } from './providers/types.js';

export const DIGEST_SYSTEM_PROMPT = `You write Functional Digests for a product team's field-testing app. A digest describes one merged pull request in the language a non-technical tester reads: what changed for the user and how to try it. The digest leaves the developer's machine; the pull request does not. You are the only step that sees the code, so you must leave every trace of it behind.

Write user-facing, functional language only. Describe behaviour a person can see or do in the product: screens, buttons, flows, outcomes, data they enter or see.

Never include any of the following, in any field:
- identifiers from the code: function, class, variable, component, hook, table, column, type or constant names, in camelCase, snake_case, PascalCase or dotted form;
- file names, file paths, directories, extensions, package or module names;
- code, pseudo-code, commands, configuration, SQL, JSON, log lines, stack traces, inline backticks or code fences;
- URLs, hostnames, e-mail addresses, branch names, commit messages, pull request numbers or ticket numbers;
- secrets or anything that resembles a key, token, password or credential;
- the names of people, vendors, model providers or internal tools.
If a fact can only be stated with one of those, describe the user-visible effect instead or leave it out. When the change has no user-visible effect, say so plainly and classify it as a chore.

Classify the change as exactly one of: "feature" (something new the user can do), "fix" (something that was broken now works), "enhancement" (something existing works better), "chore" (no user-visible effect).

Write a title of at most 120 characters and a summary of at most 1000 characters. The summary says what changed for the user, who is affected, and anything they should notice. Write in plain, present-tense sentences. Do not mention the pull request, the code, or the process of making the change.

Produce test items: concrete things a tester can try in the product to confirm the change. Give at most 20 items, fewer when the change is small, none for a chore with no visible effect. Each item has: a short title; ordered steps a tester follows (one action per step, at most 10 steps, each under 300 characters); the expected outcome (one or two sentences, under 300 characters); and a priority of "high", "medium" or "low" by how much a failure would matter to a user. Steps say what to tap, type, scan or look at. They never reference the code.

You may be given a list of open feedback items, each with an id. If the change clearly addresses one of them, copy its id verbatim into addresses_feedback. Only ids from that list are allowed; never invent an id, never rephrase one, and leave the list empty when nothing applies.

Output: respond with a single strict JSON object matching the schema you were given and nothing else - no prose before or after, no code fence, no comments, no trailing commas. Use double quotes. Every field is required; use empty arrays rather than omitting them.`;

export const RESOLUTION_SYSTEM_PROMPT = `You match open tester feedback to shipped changes. You receive a list of feedback items (each with an id and the tester's words) and a list of digests (each with an external_ref, a title and a summary written in user-facing language).

For each feedback item that a digest plausibly addresses, output a match with: the feedback_id copied verbatim; the digest_external_ref copied verbatim; a confidence between 0 and 1 reflecting how certain you are that the digest resolves the feedback as described (1 means the digest states this exact problem is fixed; 0.5 means it is related but not clearly resolved); and a note of one plain-language sentence, under 500 characters, telling the tester why this change may resolve their feedback and what to re-check.

The note is shown to testers. It must use only user-facing language: no identifiers, file names, code, URLs, e-mail addresses or technical jargon. Do not restate the whole digest.

Only use ids and external_refs that appear in the input; never invent one. Omit feedback items with no plausible match. Prefer fewer, well-grounded matches over many weak ones.

Output: a single strict JSON object of the form {"matches": [...]} and nothing else - no prose, no code fence. Return {"matches": []} when nothing matches.`;

function section(title: string, body: string): string {
  return `## ${title}\n${body.trim() === '' ? '(none)' : body}\n`;
}

export function buildDigestUserMessage(input: DigestInput): string {
  const feedback =
    input.openFeedback.length === 0
      ? 'No open feedback.'
      : input.openFeedback.map((f) => `- id: ${f.id} | severity: ${f.severity} | ${f.text}`).join('\n');
  const files = input.files.map((f) => `- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`).join('\n');
  return [
    'Write the Functional Digest for this merged pull request.',
    '',
    section('Title', input.title),
    section('Description', input.body),
    section('Labels', input.labels.join(', ')),
    section('Merged at', input.mergedAt ?? 'unknown'),
    section('Changed files', files),
    section('Diff (bounded)', input.diff),
    section('Open feedback (ids you may reference)', feedback),
  ].join('\n');
}

export function buildResolutionUserMessage(feedback: FeedbackItem[], digests: Digest[]): string {
  const fb = feedback.map((f) => `- feedback_id: ${f.id} | severity: ${f.severity} | ${f.text}`).join('\n');
  const dg = digests
    .map((d) => `- external_ref: ${d.external_ref} | ${d.change_type} | ${d.title}\n  ${d.summary}`)
    .join('\n');
  return ['Match the open feedback to the shipped digests.', '', section('Open feedback', fb), section('Digests', dg)].join('\n');
}
