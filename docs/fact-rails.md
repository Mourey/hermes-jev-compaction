# Fact rails (v0.5.0)

Before v0.5.0 a call Jev scored as stale was stubbed: its arguments emptied, its result replaced by
`dropped by jev-compaction`, or cut to a head. On real transcripts that lost most non-reproducible facts:
HTTP codes, errors, pids, ids, counters. A re-run of the tool does not bring them back.

v0.5.0 ports the rules of the fact-keeping Claude Code fork
([deadczarvc/jev-factkeep-compaction](https://github.com/deadczarvc/jev-factkeep-compaction)). Both engines
run the same rules and kept the same facts in every measurement.

## Rules

- **Nothing is erased.** A dropped call keeps its row and its `tool_call_id`. Its argument fields are cut to
  200 chars.
- **Reproducible read** (`read_file`, `search_files`, `ls`, `cat`, `rg`, `git log`…): shrinks to a one-line
  note. It must be longer than 3000 chars and carry no failure, timeout or background-job marker. Logs, JSONL
  ledgers, `journalctl`, `docker logs`, `-Tail` / `-Wait` and `tail -f` never count as reproducible.
- **Observation** (anything else) keeps:
  - its head, cut on a line boundary;
  - its fact lines, up to 30% of its size: errors, HTTP codes, paths, versions, ids, endpoints, counts,
    receipts of non-idempotent calls;
  - its tail;
  - a note that the full output stays in the session history (`state.db`) under its `tool_call_id`.
- **Never cut:**
  - observations of 6000 chars or less;
  - dense dumps up to 20k chars, where fact lines are at least half the text;
  - the first 2000 chars of an error.
- **Rail tiers** (`RAIL_TIERS`, `RAIL_FLOOR = 0.2`): the strictest tier whose reduction clears the floor is
  used (kept in the engine's `_rail_tier`).
- **Jev unreachable** (transport error, malformed answer, redactor failure): `mode = "fallback"`. Every old
  unpinned call is reduced by the same rules as a `drop_result`, with no HTTP and no summary. Before v0.5.0
  the engine returned the history unchanged (`mode = "preserve"`).
- Egress is unchanged: fact stubs are computed locally, and in `metadata` mode no result text leaves the
  process.

## Evidence

The method is the same as in the Claude fork's
[docs/evidence.md](https://github.com/deadczarvc/jev-factkeep-compaction/blob/main/docs/evidence.md):

- real Claude Code subagent transcripts, replayed through the Hermes engine;
- facts preregistered with sha256 before any run;
- real Jev (`jev-1.13.0`), `egress_mode = metadata`.

| round | facts | v0.4.x | v0.5.0 | token reduction v0.4.x → v0.5.0 |
|---|---|---|---|---|
| held-out round 4 (5 new transcripts, final rules) | 75 | 13/75 | 70/75 | 0.920 → 0.583 |
| rounds 0–3 (16 transcripts, in-sample for the final rules) | 211 | 40/211 | 211/211 | 0.881 → 0.542 |

- Round 4: exact McNemar b = 57, c = 0, p = 1.4e-17. No fact kept by v0.4.x was lost.
- The preregistered 94% target was missed by one fact (70/75, 95% CI 0.85–0.98).
- The five losses are observation lines inside long results. Two came from compound commands (`wc -l f && sed -n …`, `cat …; ls -la …`) read as reproducible. Three sat in 11–29k outputs where no fact line matched.

## Price

About 42–46% of the tokens remain after compaction, against 8–12% before. The floor keeps every compaction
at a reduction of 0.2 or more.
