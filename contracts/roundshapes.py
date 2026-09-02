# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""Round shapes: which kinds of consensus round actually land.

Courtscan reads rounds that other contracts happened to produce. This one
produces rounds on purpose, in three shapes, so the difference between them can
be counted rather than guessed at.

    fetch_only        one web fetch, agreed under strict_eq, no model
    fetch_then_reason the same fetch, then a model asked one question about it
    deterministic     no nondeterministic block at all, the control

Every call does the same amount of everything else: the same URL, the same
storage write, the same return shape. The only thing that varies is what the
round contains, which is the whole point of running it three ways.

Why this is worth a contract
----------------------------

Working on other contracts we noticed that rounds which fetch and then reason
seemed to time out while rounds that only fetch seemed to land. Seemed is the
operative word: one timeout observed while debugging is an anecdote, and we were
about to publish it as a finding. So instead the three shapes are run side by
side and counted, and whatever the counts say is what gets published, including
the possibility that there is no difference at all.

The contract records nothing about success or failure itself, deliberately. A
round that is discarded takes its own state change with it, so a contract cannot
write down that it failed. The outcome has to be read from the receipt by
whoever sent the transaction, which is exactly what Courtscan does for rounds it
did not send.

Rules this obeys
----------------

Nothing inside a nondeterministic block reads storage or raises: on chain id
4221 touching `self.<field>` from inside ends FINISHED_WITH_ERROR, and a throw
there reverts the whole transaction rather than the round. One field is bound to
the equivalence rule in each shape, because every extra bound field costs
agreement.
"""

from genlayer import *
from datetime import datetime, timezone
import json


MAX_EXCERPT = 600

# A source chosen for being small, public, and identical for every validator.
# Anything that varies by location would fail strict_eq for reasons that have
# nothing to do with the shape of the round, and the measurement would be about
# geography instead.
DEFAULT_SOURCE = "https://api.github.com/repos/JspIIV/courtscan"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _url(value: str) -> str:
    text = str(value).strip()
    if not text.startswith("https://") or len(text) > 300 or " " in text:
        return DEFAULT_SOURCE
    return text


class RoundShapes(gl.Contract):
    # What landed. A discarded round never reaches this, which is the property
    # being measured: the gap between this list and the number of transactions
    # sent is the failure rate.
    runs: DynArray[str]

    def __init__(self) -> None:
        pass

    def _record(self, shape: str, detail: str) -> str:
        index = len(self.runs)
        self.runs.append(json.dumps({
            "index": index, "shape": shape, "detail": detail, "at": _now_iso(),
        }))
        return json.dumps({"ok": True, "index": index, "shape": shape, "detail": detail})

    @gl.public.write
    def fetch_only(self, source: str) -> str:
        """One fetch, agreed exactly, no model."""
        url = _url(source)

        def look() -> str:
            try:
                response = gl.nondet.web.get(url)
                return "HTTP_" + str(int(response.status))
            except Exception:
                return "UNREACHABLE"

        agreed = str(gl.eq_principle.strict_eq(look))
        return self._record("fetch_only", agreed)

    @gl.public.write
    def fetch_then_reason(self, source: str) -> str:
        """The same fetch, and then one question put to a model about it."""
        url = _url(source)

        def run() -> str:
            try:
                response = gl.nondet.web.get(url)
                body = response.body.decode("utf-8", "replace")[:MAX_EXCERPT]
            except Exception:
                body = ""
            try:
                return str(gl.nondet.exec_prompt(
                    "Here is the beginning of a JSON document:\n\n" + body +
                    "\n\nAnswer with bare JSON and nothing else: "
                    '{"reachable": "YES" or "NO"} where YES means the document '
                    "above contains any readable text at all."))
            except Exception:
                return ""

        raw = str(gl.eq_principle.prompt_comparative(
            run,
            principle=("Both answers must carry the same value in the field named reachable, "
                       "either YES or NO. Nothing else is compared."),
        ))
        answer = "YES" if '"YES"' in raw.upper() else ("NO" if '"NO"' in raw.upper() else "UNREADABLE")
        return self._record("fetch_then_reason", answer)

    @gl.public.write
    def deterministic(self, source: str) -> str:
        """The control. No round at all, and the same storage write."""
        return self._record("deterministic", _url(source)[:40])

    # ------------------------------------------------------------------ reads

    @gl.public.view
    def size(self) -> str:
        counts = {}
        for raw in self.runs:
            shape = json.loads(raw)["shape"]
            counts[shape] = counts.get(shape, 0) + 1
        return json.dumps({
            "landed": len(self.runs),
            "by_shape": counts,
            "note": ("this counts only what landed; a discarded round takes its own state "
                     "change with it, so the failures are visible in the receipts rather "
                     "than here"),
        })

    @gl.public.view
    def run_at(self, index: str) -> str:
        try:
            position = int(str(index).strip())
        except Exception:
            return json.dumps({"ok": False, "error": "no such run"})
        if position < 0 or position >= len(self.runs):
            return json.dumps({"ok": False, "error": "no such run"})
        return self.runs[position]
