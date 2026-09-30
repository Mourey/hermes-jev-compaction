# Fact rails (v0.5.0, refined in v0.6.0)

Before v0.5.0 a call Jev scored as stale was stubbed: its arguments emptied, its result replaced by
`dropped by jev-compaction`, or cut to a head. On real transcripts that lost most non-reproducible facts:
HTTP codes, errors, pids, ids, counters. A re-run of the tool does not bring them back.

v0.5.0 ports the rules of the fact-keeping Claude Code fork
([deadczarvc-labs/jev-factkeep-compaction](https://github.com/deadczarvc-labs/jev-factkeep-compaction)). Both engines
run the same rules and kept the same facts in every measurement.

## Rules

- **Nothing is erased.** A dropped call keeps its row and its `tool_call_id`. Its argument fields are cut to
  200 chars.
- **Reproducible read** (`read_file`, `search_files`, `ls`, `cat`, `rg`, `git log`…): shrinks to a one-line
  note. It must be longer than 3000 chars and carry no failure, timeout or background-job marker. Logs, JSONL
  ledgers, `journalctl`, `docker logs`, `-Tail` / `-Wait` and `tail -f` never count as reproducible. Since v0.6.0 a
  read that reports file metadata (`wc`, `stat`, `du`, `df`, `ls -l`, `Get-ChildItem`), alone or inside a compound
  command, is an observation too: counts, sizes and times are measurements taken at one moment.
- **Observation** (anything else) keeps:
  - its head, cut on a line boundary;
  - its fact lines, up to 30% of its size: errors, HTTP codes, paths, versions, ids, endpoints, counts,
    receipts of non-idempotent calls. Since v0.6.0 a line longer than 200 chars (a JSON string with escaped
    newlines, a minified record) is split into pieces instead of being cut at 200 chars;
  - its tail;
  - a note that the full output stays in the session history (`state.db`) under its `tool_call_id`.
- **Never cut:**
  - observations of 6000 chars or less;
  - dense dumps up to 32k chars (20k before v0.6.0), where fact lines are at least half the text;
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
[docs/evidence.md](https://github.com/deadczarvc-labs/jev-factkeep-compaction/blob/main/docs/evidence.md):

- real Claude Code subagent transcripts, replayed through the Hermes engine;
- facts preregistered with sha256 before any run;
- real Jev (`jev-1.13.0`), `egress_mode = metadata`.

| round | facts | v0.4.x | fact rails | token reduction v0.4.x → fact rails |
|---|---|---|---|---|
| held-out round 5 (4 new transcripts, v0.6.0, blind) | 50 | 4/50 | **50/50** | 0.876 → 0.445 |
| held-out round 4 (5 new transcripts, v0.5.0, blind) | 75 | 13/75 | 70/75 | 0.920 → 0.583 |
| rounds 0–4 with v0.6.0 (21 transcripts, in-sample) | 286 | 53/286 | 286/286 | → 0.519 |

- Round 5 (v0.6.0): the preregistered bar was 47/50 with a reduction ≥ 0.20 on every transcript.
  - Kept: 50/50, 95% CI 0.929–1.000.
  - Reduction: minimum 0.253.
  - Exact McNemar b = 46, c = 0, p = 2.8e-14.
  - Jev dropped every unpinned call, so the round measures the keeping rules.
- Round 4 (v0.5.0): 70/75, b = 57, c = 0, p = 1.4e-17. It missed the 94% bar by one fact. The five losses are the class that v0.6.0 fixes:
  - metadata inside compound reads;
  - facts deep in very long lines;
  - a 29k dense table.
- No fact kept by v0.4.x was lost in any round.

## Price

About 42–56% of the tokens remain after compaction, against 8–12% before. The floor keeps every compaction
at a reduction of 0.2 or more.
