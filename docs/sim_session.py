"""Session simulation for the Hermes engine (same model as the Claude fork's docs/data/sim_v2.mts): compaction at 60% of the window (chars),
recorded Jev decisions, floor 1 - 0.50/p when SIM_PRESSURE=1 (else the engine's default), no summary cliff (Hermes
has none). Facts kept = needle in its own result at the end; "saved" also counts results whose note names a saved
output (the offload phrase). argv: plugin dir, transcript dirs (';'-separated)."""
import importlib.util, json, os, pathlib, sys

HROOT = pathlib.Path(os.environ["LOCALAPPDATA"]) / "hermes"
sys.path.insert(0, str(HROOT / "hermes-agent"))
plug = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("jev_sim_engine", plug / "__init__.py", submodule_search_locations=[str(plug)])
mod = importlib.util.module_from_spec(spec); sys.modules["jev_sim_engine"] = mod; spec.loader.exec_module(mod)
PRESSURE = os.environ.get("SIM_PRESSURE") == "1"
import re as _re
if os.environ.get("SIM_TIERS_OLD") == "1":
    mod.RAIL_TIERS = (mod.RAIL_TIERS[0], {"small": 3000, "share": 0.2, "read_keep": 1500, "dense_keep": 0, "dense_share": 1.0}, mod.RAIL_TIERS[-1])
if os.environ.get("SIM_NO_IDEM") == "1":
    mod._COMPACTED_MARK = _re.compile(r"(?!x)x")
FIXED = os.environ.get("SIM_FLOOR")
note_of = None if os.environ.get("SIM_NO_SAVED") == "1" else getattr(mod, "full_output_note", None)


def hermes_messages(canon):
    out = [{"role": "system", "content": "system"}]
    for m in canon["messages"]:
        if m["role"] == "assistant":
            e = {"role": "assistant", "content": m["text"]}
            if m["tool_uses"]:
                e["tool_calls"] = [{"id": t["id"], "type": "function", "function": {"name": t["name"], "arguments": json.dumps(t["input"], ensure_ascii=False)}} for t in m["tool_uses"]]
            out.append(e)
        else:
            for r in m["tool_results"]:
                out.append({"role": "tool", "tool_call_id": r["id"], "content": r["text"], "is_error": r["is_error"]})
            if m["text"]:
                out.append({"role": "user", "content": m["text"]})
    return out


def chars(ms):
    return sum(len(mod._content_text(m.get("content"))) + sum(len(str((tc.get("function") or {}).get("arguments") or "")) for tc in m.get("tool_calls") or []) for m in ms)


for mm in (0.8, 1.0, 1.2, 1.5):
    kept = total = compactions = 0
    finals = []
    for d in filter(None, sys.argv[2].split(";")):
        d = pathlib.Path(d)
        canon = json.loads((d / "canonical.json").read_text(encoding="utf-8"))
        facts = json.loads((d / "facts.json").read_text(encoding="utf-8"))["facts"]
        run = json.loads((d / "fork-run1.json").read_text(encoding="utf-8"))
        ids = {r["id"][-6:]: r["id"] for m in canon["messages"] for r in m["tool_results"]}
        all_msgs = hermes_messages(canon)
        W = chars(all_msgs) / mm
        ctx, saved = [], set()
        for msg in all_msgs:
            ctx.append(msg)
            if msg.get("role") != "tool" or chars(ctx) < 0.6 * W:
                continue
            eng = mod.JevEngine(); eng.protect_last_n = 6; eng._messages_ref = ctx
            calls = eng._collect_calls(ctx)
            decisions = {c["id"]: ("keep" if c["pinned"] else (run["decisions"].get(c["tool_call_id"]) or {}).get("action", "keep")) for c in calls}
            p = chars(ctx) / W
            out = eng._apply(ctx, calls, decisions, (float(FIXED) if FIXED else min(0.9, max(0.05, 1 - 0.5 / p))), max(0.0, 1 - float(os.environ.get("SIM_HARD", "0.57")) / p)) if PRESSURE else eng._apply(ctx, calls, decisions)
            compactions += 1
            if note_of:
                saved |= {m["tool_call_id"] for m in out if m.get("role") == "tool" and note_of(m["tool_call_id"]) in mod._content_text(m.get("content"))}
            ctx = out
        finals.append(round(chars(ctx) / W, 2))
        res = {m["tool_call_id"]: mod._content_text(m.get("content")) for m in ctx if m.get("role") == "tool"}
        for f in facts:
            total += 1
            tc = ids.get(f["src"][-6:], "")
            kept += f["needle"] in res.get(tc, "") or tc in saved
    print(json.dumps({"m": mm, "kept": kept, "total": total, "compactions": compactions, "final_over_window_max": max(finals), "over_window": sum(f > 1.0 for f in finals), "over_trigger": sum(f > 0.6 for f in finals)}))
