# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""AssayCompose: the third axis of the Assay lab, where the judgement is composed, not chosen.

The classify probe in Assay asks validators to CHOOSE from fixed vocabularies and agree; across
every size and bound-field count it never broke a round. This measures the axis the project always
said was the real lever: asking validators to COMPOSE a judgement under a clock, a decision, a named
precedent, a holding sentence and a rationale written on the spot, and then agree it means the same.

Same honest asymmetry as Assay: a round that agrees writes itself in and cannot be faked; a round that
does not has its state change discarded and is attested afterwards with the transaction hash anybody
can check. Grading is always COMPARATIVE, because composed prose cannot match character for character
between validators; the question is whether two independently composed judgements mean the same thing.

A standalone contract rather than more methods on Assay, because the combined source exceeds the
network's per-transaction deploy gas cap. The two together are the lab; this one carries the compose axis.
"""

from genlayer import *
from datetime import datetime, timezone
import json

ERROR_EXPECTED = "[EXPECTED_ERROR]"

DECISIONS = ["ALLOW", "WARN", "BLOCK", "ESCALATE"]
# The composed fields, in rising order of how much must be written and then agreed.
COMPOSE_FIELDS = ["decision", "precedent", "holding", "rationale"]
MIN_HOLDING_CHARS = 20
MIN_RATIONALE_CHARS = 120

OUTCOME_AGREED = "AGREED"
OUTCOME_TIMEOUT = "TIMEOUT"
OUTCOME_NOT_VOTED = "NOT_VOTED"
OUTCOME_ERROR = "FINISHED_WITH_ERROR"
OUTCOME_REVERTED = "REVERTED"
REPORTABLE = [OUTCOME_TIMEOUT, OUTCOME_NOT_VOTED, OUTCOME_ERROR, OUTCOME_REVERTED]
# Only failures that say something about agreement move the frontier.
COUNTS_AGAINST_AGREEMENT = [OUTCOME_TIMEOUT, OUTCOME_ERROR]

MAX_EVIDENCE_CHARS = 12000
MAX_URL = 400
TX_HASH_LEN = 66


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _addr(address) -> str:
    return str(address).lower()


def _http(url: str) -> str:
    text = str(url).strip()
    if not (text.startswith("http://") or text.startswith("https://")):
        raise gl.vm.UserError(ERROR_EXPECTED + " A source must be an http or https URL")
    if len(text) > MAX_URL:
        raise gl.vm.UserError(ERROR_EXPECTED + " That URL is unreasonably long")
    return text


def _filler(size: int) -> str:
    """Dull repetitive prose of an exact length, to isolate payload size from content."""
    unit = ("The record states the figure and the date it was taken, and the "
            "note beside it repeats the figure so the two can be compared. ")
    if size <= 0:
        return ""
    times = (size // len(unit)) + 1
    return (unit * times)[:size]


def _compose_bound(budget: int) -> list:
    return COMPOSE_FIELDS[:max(1, min(len(COMPOSE_FIELDS), int(budget)))]


class AssayCompose(gl.Contract):
    # A round that agreed, written by the round itself.
    runs: DynArray[str]
    # A round that did not, attested afterwards with its transaction hash.
    reports: DynArray[str]

    def __init__(self) -> None:
        pass

    def _task_compose(self, page: str, budget: int) -> str:
        """A judgement composed, not chosen; the ask grows with the budget. Arguments only."""
        asks = [
            'decision: one of ' + ", ".join(DECISIONS)
            + ' (does the conduct in the document warrant allowing, warning, blocking, or escalating)',
            'precedent: a short name for the prior principle your decision rests on, '
            'in your own words, at most a dozen words',
            'holding: one sentence, composed now, stating what is held and why, '
            'at least ' + str(MIN_HOLDING_CHARS) + ' characters',
            'rationale: two or three sentences giving the reasoning, '
            'at least ' + str(MIN_RATIONALE_CHARS) + ' characters',
        ]
        wanted = asks[:budget]
        shape_bits = ['"decision": "WARN"']
        if budget >= 2:
            shape_bits.append('"precedent": "..."')
        if budget >= 3:
            shape_bits.append('"holding": "..."')
        if budget >= 4:
            shape_bits.append('"rationale": "..."')
        return (
            "You are a supervisor reviewing the conduct described in the document "
            "below. Read it and compose a judgement. There is a time limit, and "
            "other validators are composing their own judgement of the same "
            "document independently; your composed judgement has to mean the same "
            "as theirs, not match it word for word.\n\n"
            "<document>\n" + page + "\n</document>\n\n"
            "Produce these fields:\n" + "\n".join(wanted) + "\n\n"
            "Return ONLY a JSON object of exactly this shape:\n"
            "{" + ", ".join(shape_bits) + "}\n"
            "Return ONLY the JSON."
        )

    def _parse_compose(self, raw: str, budget: int) -> dict:
        """Never raises; a refusal comes back as data."""
        text = str(raw).strip()
        if text.startswith("```"):
            parts = text.split("```")
            text = parts[1] if len(parts) > 1 else text
            if text.startswith("json"):
                text = text[4:]
        start, end = text.find("{"), text.rfind("}") + 1
        if start >= 0 and end > start:
            text = text[start:end]
        try:
            parsed = json.loads(text)
        except (ValueError, TypeError):
            return {"ok": False, "why": "the model did not return JSON"}
        if not isinstance(parsed, dict):
            return {"ok": False, "why": "the model returned something else"}

        decision = str(parsed.get("decision", "")).strip().upper()
        if decision not in DECISIONS:
            return {"ok": False, "why": "unknown decision " + decision[:30]}
        out = {"ok": True, "decision": decision}
        if budget >= 2:
            precedent = str(parsed.get("precedent", "")).strip()
            if precedent == "":
                return {"ok": False, "why": "no precedent composed"}
            out["precedent"] = precedent
        if budget >= 3:
            holding = str(parsed.get("holding", "")).strip()
            if len(holding) < MIN_HOLDING_CHARS:
                return {"ok": False, "why": "holding too short to be a holding"}
            out["holding"] = holding
        if budget >= 4:
            rationale = str(parsed.get("rationale", "")).strip()
            if len(rationale) < MIN_RATIONALE_CHARS:
                return {"ok": False, "why": "rationale too short to be a rationale"}
            out["rationale"] = rationale
        return out

    @gl.public.write
    def probe_compose(self, source_url: str, evidence_chars: str, compose_budget: str) -> None:
        """One controlled round where the judgement is composed, graded COMPARATIVE. Anyone may run one."""
        source = _http(source_url)
        try:
            size = int(evidence_chars)
        except (ValueError, TypeError):
            raise gl.vm.UserError(ERROR_EXPECTED + " evidence_chars must be a whole number")
        if size < 0 or size > MAX_EVIDENCE_CHARS:
            raise gl.vm.UserError(
                ERROR_EXPECTED + " evidence_chars must be between 0 and " + str(MAX_EVIDENCE_CHARS))
        try:
            budget = int(compose_budget)
        except (ValueError, TypeError):
            raise gl.vm.UserError(ERROR_EXPECTED + " compose_budget must be a whole number")
        if budget < 1 or budget > len(COMPOSE_FIELDS):
            raise gl.vm.UserError(
                ERROR_EXPECTED + " compose_budget must be between 1 and " + str(len(COMPOSE_FIELDS)))

        bound = _compose_bound(budget)
        started = _now_iso()

        def run() -> dict:
            try:
                page = str(gl.nondet.web.render(source, mode="text"))
            except Exception:
                page = ""
            if len(page) < size:
                page = page + _filler(size - len(page))
            page = page[:size]
            return self._parse_compose(gl.nondet.exec_prompt(self._task_compose(page, budget)), budget)

        answer = json.loads(gl.eq_principle.prompt_comparative(
            lambda: json.dumps(run()),
            principle=(
                "Two validators each composed a judgement of the same document under a time "
                "limit. Treat them as agreeing only if the ok field matches and, when ok is "
                "true, the decision field is identical and every composed field present "
                "(precedent, holding, rationale) carries the same substance as the other's: "
                "the same governing principle, a holding with the same effect, a rationale "
                "making the same core point. Wording may differ freely; substance may not. If "
                "either side did not produce the required fields, or the decisions differ, or "
                "a composed field says something materially different, they do not agree."
            ),
        ))

        self.runs.append(json.dumps({
            "run_id": str(len(self.runs)),
            "kind": "COMPOSE",
            "source_url": source,
            "evidence_chars": size,
            "compose_budget": budget,
            "bound": bound,
            "mode": "COMPARATIVE",
            "outcome": OUTCOME_AGREED,
            "answer": answer,
            "ran_by": _addr(gl.message.sender_address.as_hex),
            "started_at": started,
            "recorded_at": _now_iso(),
        }))

    @gl.public.write
    def report_failure(self, tx_hash: str, source_url: str, evidence_chars: str,
                       compose_budget: str, outcome: str, note: str) -> None:
        """Records a compose probe that never came back, citing the hash that proves it."""
        digest = str(tx_hash).strip().lower()
        if not digest.startswith("0x") or len(digest) != TX_HASH_LEN:
            raise gl.vm.UserError(
                ERROR_EXPECTED + " A failure has to cite the transaction hash of the probe")
        result = str(outcome).strip().upper()
        if result not in REPORTABLE:
            raise gl.vm.UserError(
                ERROR_EXPECTED + " outcome must be one of " + ", ".join(REPORTABLE))
        try:
            budget = int(compose_budget)
        except (ValueError, TypeError):
            raise gl.vm.UserError(ERROR_EXPECTED + " compose_budget must be a whole number")
        if budget < 1 or budget > len(COMPOSE_FIELDS):
            raise gl.vm.UserError(
                ERROR_EXPECTED + " compose_budget must be between 1 and " + str(len(COMPOSE_FIELDS)))

        for raw in self.reports:
            if json.loads(raw)["tx_hash"] == digest:
                raise gl.vm.UserError(ERROR_EXPECTED + " That transaction is already reported")

        self.reports.append(json.dumps({
            "report_id": str(len(self.reports)),
            "kind": "COMPOSE",
            "tx_hash": digest,
            "source_url": str(source_url)[:MAX_URL],
            "evidence_chars": int(evidence_chars),
            "compose_budget": budget,
            "mode": "COMPARATIVE",
            "outcome": result,
            "note": str(note)[:300],
            "reported_by": _addr(gl.message.sender_address.as_hex),
            "reported_at": _now_iso(),
            "verify": "read the receipt for tx_hash; this contract cannot",
        }))

    @gl.public.view
    def get_frontier(self) -> str:
        """Per compose_budget: the largest payload that ever agreed and the smallest that ever failed."""
        rows = {}

        def slot(budget: int) -> dict:
            key = str(budget)
            if key not in rows:
                rows[key] = {
                    "kind": "COMPOSE", "mode": "COMPARATIVE",
                    "compose_budget": budget, "load": budget,
                    "largest_agreed": None, "smallest_failed": None,
                    "agreed": 0, "failed": 0, "set_aside": 0,
                }
            return rows[key]

        for raw in self.runs:
            run = json.loads(raw)
            row = slot(int(run["compose_budget"]))
            row["agreed"] += 1
            size = int(run["evidence_chars"])
            if row["largest_agreed"] is None or size > row["largest_agreed"]:
                row["largest_agreed"] = size

        for raw in self.reports:
            report = json.loads(raw)
            row = slot(int(report["compose_budget"]))
            size = int(report["evidence_chars"])
            if report["outcome"] in COUNTS_AGAINST_AGREEMENT:
                row["failed"] += 1
                if row["smallest_failed"] is None or size < row["smallest_failed"]:
                    row["smallest_failed"] = size
            else:
                row["set_aside"] += 1

        out = []
        for key in sorted(rows.keys(), key=lambda k: int(k)):
            row = rows[key]
            row["observations"] = row["agreed"] + row["failed"]
            row["settled"] = (row["largest_agreed"] is not None
                              and row["smallest_failed"] is not None
                              and row["largest_agreed"] < row["smallest_failed"])
            out.append(row)
        return json.dumps({
            "frontier": out,
            "compose_fields_in_order": COMPOSE_FIELDS,
            "counts_against_agreement": COUNTS_AGAINST_AGREEMENT,
            "caution": ("largest_agreed agreed at least once, smallest_failed failed at least "
                        "once; read observations first"),
            "set_aside_means": "NOT_VOTED or REVERTED: kept and shown, do not move the frontier",
        })

    @gl.public.view
    def get_runs(self) -> str:
        return json.dumps([json.loads(r) for r in self.runs])

    @gl.public.view
    def get_reports(self) -> str:
        return json.dumps([json.loads(r) for r in self.reports])

    @gl.public.view
    def get_stats(self) -> str:
        return json.dumps({
            "rounds_that_agreed": len(self.runs),
            "rounds_reported_failed": len(self.reports),
            "compose_fields_in_order": COMPOSE_FIELDS,
            "max_evidence_chars": MAX_EVIDENCE_CHARS,
            "how_to_read_this": (
                "rounds_that_agreed were written by the rounds themselves and cannot be faked; "
                "rounds_reported_failed are attested afterwards with a transaction hash"),
        })
