"""jev-context-engine keeps facts when compacting (port of the fact-keeping fast-jev-compaction fork).

The goal both engines state: drop what re-running the tool gives back, never an exact error, path or
observation. Run: python -B -m pytest tests/test_fact_rails.py -q
"""

import importlib.util
import json
import pathlib
import sys

PLUGIN = pathlib.Path(__file__).resolve().parents[1] / "hermes-plugin"
spec = importlib.util.spec_from_file_location(
    "jev_context_engine",
    PLUGIN / "__init__.py",
    submodule_search_locations=[str(PLUGIN)],
)
engine = importlib.util.module_from_spec(spec)
sys.modules["jev_context_engine"] = engine
spec.loader.exec_module(engine)


def test_reproducible_reads_versus_observations_and_side_effects():
    assert engine.reproducible("read_file", {"path": "a.py"})
    assert engine.reproducible(
        "terminal", {"command": "ls F:/Temp 2>&1 | head -40; find F:/Temp -type d"}
    )  # a long listing (ls -la) reports metadata: see the metadata test below
    assert engine.reproducible("terminal", {"command": "git log --oneline | head -5"})
    for tool, args in [
        ("terminal", {"command": "curl -s https://x.org"}),
        ("terminal", {"command": "netstat -ano | grep 3845"}),
        ("terminal", {"command": "ls > out.txt"}),
        ("terminal", {"command": "sed -i 's/a/b/' f"}),
        ("write_file", {"path": "a.py", "content": "x"}),
        ("web_extract", {"urls": ["https://x.org"]}),
    ]:
        assert not engine.reproducible(tool, args), (tool, args)


def test_fact_stub_keeps_deep_fact_lines_head_and_tail():
    middle = (
        "plain filler line without anything\n"
        "GET https://mcp.unframer.co/.well-known/oauth-authorization-server HTTP 404\n"
        "@codex-codegraph | live | node.exe | pid 43748\n"
        "figma-desktop err=Failed to connect to 127.0.0.1:3845"
    )
    text = (
        "h" * 300
        + "\n"
        + "filler\n" * 500  # past SMALL_KEEP_CHARS (6000)
        + middle
        + "\n"
        + "filler\n" * 500
        + "t" * 120
    )
    stub = engine.fact_stub(text, False)
    for fact in ("HTTP 404", "pid 43748", "127.0.0.1:3845"):
        assert fact in stub
    assert "plain filler line" not in stub
    assert stub.endswith("t" * 120) and len(stub) < len(text) / 2
    error = "Traceback\n" + "e" * 1900
    assert engine.fact_stub(error, True) == error


def test_apply_shrinks_reads_keeps_observation_stubs_and_pairing():
    big = (
        "x" * 1000 + "\nGET https://a.example/.well-known/oauth HTTP 404\n" + "x" * 1000
    )
    messages = [
        {"role": "user", "content": "audit"},
        {
            "role": "assistant",
            "tool_calls": [
                {
                    "id": "r1",
                    "type": "function",
                    "function": {
                        "name": "read_file",
                        "arguments": json.dumps({"path": "src/a.py"}),
                    },
                },
                {
                    "id": "c1",
                    "type": "function",
                    "function": {
                        "name": "terminal",
                        "arguments": json.dumps(
                            {"command": "curl -s https://a.example/.well-known/oauth"}
                        ),
                    },
                },
            ],
        },
        {"role": "tool", "tool_call_id": "r1", "content": big},
        {"role": "tool", "tool_call_id": "c1", "content": big},
    ]
    calls = [
        {
            "id": "t1",
            "tool_call_id": "r1",
            "tool": "read_file",
            "input": {"path": "src/a.py"},
        },
        {
            "id": "t2",
            "tool_call_id": "c1",
            "tool": "terminal",
            "input": {"command": "curl -s https://a.example/.well-known/oauth"},
        },
    ]
    out = engine.JevEngine._apply(
        engine.JevEngine(), messages, calls, {"t1": "drop_call", "t2": "drop_call"}
    )
    assert (
        out[2]["content"].startswith("[jev-compaction omitted")
        and "reproducible read" in out[2]["content"]
    )
    assert "HTTP 404" in out[3]["content"]
    ids = [tc["id"] for tc in out[1]["tool_calls"]]
    assert ids == ["r1", "c1"]  # pairing intact, nothing erased
    assert json.loads(out[1]["tool_calls"][0]["function"]["arguments"]) == {
        "path": "src/a.py"
    }


def _history():
    # past SMALL_KEEP_CHARS (3000): shorter observations are kept whole by the hard rails
    big = (
        "x" * 3500 + "\nGET https://a.example/.well-known/oauth HTTP 404\n" + "x" * 3500
    )
    receipt = (
        "y" * 3500 + "\nmessage_id: 8f3e2a-ticket sent to 3 recipients\n" + "y" * 3500
    )
    calls = [
        ("r1", "read_file", {"path": "src/a.py"}),
        ("c1", "terminal", {"command": "curl -s https://a.example/.well-known/oauth"}),
        ("s1", "send_message", {"to": "team", "text": "x"}),
    ]
    messages = [{"role": "user", "content": "audit"}]
    for cid, name, args in calls:
        messages.append(
            {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": cid,
                        "type": "function",
                        "function": {"name": name, "arguments": json.dumps(args)},
                    }
                ],
            }
        )
        messages.append(
            {
                "role": "tool",
                "tool_call_id": cid,
                "content": receipt if cid == "s1" else big,
            }
        )
    messages.append({"role": "user", "content": "go on"})
    return messages


def test_jev_failure_falls_back_to_the_same_fact_rules_not_fail_open():
    e = engine.JevEngine()
    e.protect_last_n = 1
    e.egress_mode = "metadata"

    def down(*_a, **_k):
        raise RuntimeError("TypeSafe unreachable")

    e._fit_state = down
    messages = _history()
    out = e.compress(messages)
    assert e.last_stats["mode"] == "fallback"
    assert len(out) == len(messages)  # nothing erased, pairing kept
    assert "reproducible read" in out[2]["content"]  # read_file shrinks to a line
    assert "HTTP 404" in out[4]["content"] and len(out[4]["content"]) < len(
        messages[4]["content"]
    )
    assert (
        "message_id: 8f3e2a-ticket sent" in out[6]["content"]
    )  # receipt of a non-idempotent call survives
    assert out[-1] == messages[-1]


def test_hard_rails_short_kept_whole_tail_line_intact_pointer_named():
    short = "a" * 1200 + "\ntable vec_episodes no such module: vec0\n" + "b" * 1200
    assert (
        engine.fact_stub(short, False) == short
    )  # under SMALL_KEEP_CHARS (6000): kept whole
    body = "\n".join(f"row {i} ok" for i in range(800))
    stub = engine.fact_stub(body + "\n36220 32.02000\nend", False, "call_X")
    assert "36220 32.02000" in stub  # the line at the tail boundary is not split
    assert "under call_X" in stub and "re-run the tool" not in stub
    dump = "\n".join(
        f"pid {10000 + i} port {3000 + i} status failed" for i in range(300)
    )
    kept = [
        ln for ln in engine.fact_stub(dump, False).split("\n") if ln.startswith("pid ")
    ]
    assert len(kept) > 40  # budget proportional to size, not 360 chars


def test_logs_are_observations_not_reproducible_reads():
    assert not engine.reproducible(
        "terminal", {"command": "tail -c 1500 C:/ops/app/restic.log"}
    )
    assert not engine.reproducible(
        "read_file", {"path": "C:/ops/jev-net/ledger/screen.jsonl"}
    )
    assert not engine.reproducible("terminal", {"command": "tail -f /var/log/syslog"})
    assert engine.reproducible(
        "read_file", {"path": "C:/src/app.py"}
    )  # source files still re-read


def test_rails_dense_table_failed_read_and_tiers():
    table = "\n".join(
        f"F:/Projects/p{i} {3000 + i} {19602045188 + i}" for i in range(300)
    )
    assert (
        engine.fact_stub(table, False, "t", engine.RAIL_TIERS[0]) == table
    )  # dense dump kept whole
    assert (
        engine.fact_stub(table, False, "t", engine.RAIL_TIERS[1]) != table
    )  # a lower tier cuts it
    failed = "find: '/c/nope': No such file or directory\nCommand did not complete within its 120s timeout"
    assert engine._READ_OBSERVATION.search(
        failed
    )  # a failed read is an observation, not a re-run line
    assert engine.RAIL_FLOOR <= 0.25 and len(engine.RAIL_TIERS) == 3


def test_metadata_reads_are_observations_even_in_compound_commands():
    for command in (
        "cd /x && wc -l pin.mjs && sed -n 1,140p pin.mjs",
        "cat card.xtml; echo; ls -la /x /x/reports 2>&1",
        "stat a.txt",
        "du -sh /x",
    ):
        assert not engine.reproducible("terminal", {"command": command}), command
    assert not engine.reproducible(
        "PowerShell", {"command": "Get-ChildItem C:/x | Select-Object -First 5"}
    )
    assert engine.reproducible("terminal", {"command": "cat a.txt | head -40"})


def test_long_line_is_split_into_pieces_not_truncated():
    sep = "\\n"  # an escaped newline inside a JSON string: the line has no real line break
    filler = sep.join('\\"content\\": \\"note ' + "y" * 120 + '\\"' for _ in range(60))
    line = (
        '{"text": "'
        + filler
        + sep
        + '  \\"id\\": \\"f46101ab4a1ecfd2\\"'
        + sep
        + filler
        + '"}'
    )
    assert "\n" not in line and len(line) > 10_000
    assert any("f46101ab4a1ecfd2" in piece for piece in engine.fact_lines(line, 3000))


def test_dense_table_up_to_32k_kept_whole():
    rows = (
        f"b{i} server-{i}.exe.bak-b{i}-20260930 | wave W{i} | "
        f"['drafts:events.json', 'live:agent-{i}.jsonl'] | " + "z" * 60
        for i in range(150)
    )
    table = "\n".join(rows)
    assert 20_000 < len(table) < 32_000
    assert engine.fact_stub(table, False, "t", engine.RAIL_TIERS[0]) == table
