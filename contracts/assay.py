# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""Assay: where agreement stops working, measured on the live network.

Every builder writing an Intelligent Contract eventually asks the same question,
and there is nowhere to look it up: will my consensus round actually reach
agreement, and what makes it stop?

The documentation explains what the equivalence principle is. It does not say
how much you can put in front of validators before they run out of time, or how
much harder each additional bound field makes agreement, or what a failure even
looks like from the outside. Everyone finds out the expensive way, one dead
round at a time.

This contract finds out on purpose. A probe is one controlled round: a page is
fetched and truncated to an exact size, a model is asked for the same four
fields every time, and an exact number of those fields is required to match
between validators. Vary the size, vary how many fields are bound, and the
frontier appears: the point past which rounds stop coming back.

## The one thing that shapes the whole design

A round that fails does not get to write anything down. Consensus discards the
state change, so a contract cannot record "I timed out": the record would be
part of the transaction that was thrown away. This was measured rather than
assumed. A round observed on 2026-08-19 produced a perfectly good answer from
its leader and finalised as TIMEOUT with the answer discarded, leaving the
contract exactly as it had been.

So the two halves of a measurement have different standing, and the difference
is stated everywhere it matters rather than smoothed over:

  a round that agreed    the contract wrote it itself, inside the round. Nobody
                         can put a false success here, because writing at all
                         required agreement.

  a round that did not   attested afterwards by whoever ran it, citing the
                         transaction hash. The contract cannot verify it. The
                         receipt for that hash can, by anybody, which is why the
                         hash is required and shown.

## What is deliberately not here

No verdicts about anybody, no money, no stakes. This measures the machine, not
people. The only thing at risk is being wrong in public about a number, which
is the correct thing to be at risk of.
"""

from genlayer import *
from datetime import datetime, timezone
import json


ERROR_EXPECTED = "[EXPECTED_ERROR]"

# The four fields every probe asks for, in rising order of how much room two
# honest models have to differ. Binding more of them is the second axis of the
# experiment, and this ordering is the reason it is an axis at all: agreeing on
# what a page is about is easier than agreeing on how it feels.
FIELDS = ["topic", "language", "has_code", "tone"]

TOPICS = ["SOFTWARE", "SCIENCE", "FINANCE", "NEWS", "REFERENCE", "OTHER"]
TONES = ["NEUTRAL", "POSITIVE", "NEGATIVE"]

MODE_STRICT = "STRICT"          # a custom validator compares the fields in code
MODE_COMPARATIVE = "COMPARATIVE"  # a principle string asks a model to compare
MODES = [MODE_STRICT, MODE_COMPARATIVE]

# Outcomes a run can be reported as. AGREED is written by the round itself.
# The rest are attested afterwards with a transaction hash, because a round that
# reached them was not able to write anything.
OUTCOME_AGREED = "AGREED"
OUTCOME_TIMEOUT = "TIMEOUT"
OUTCOME_NOT_VOTED = "NOT_VOTED"
OUTCOME_ERROR = "FINISHED_WITH_ERROR"
OUTCOME_REVERTED = "REVERTED"
REPORTABLE = [OUTCOME_TIMEOUT, OUTCOME_NOT_VOTED, OUTCOME_ERROR, OUTCOME_REVERTED]

# Not every failure says something about agreement, and treating them alike
# ruins the measurement. The first probe run made this obvious: a 500 character
# round came back NOT_VOTED while a 3500 character one agreed, which would put
# the frontier below the smaller payload and read as though less text were
# harder. It is not. The network simply never got to that round.
#
#   TIMEOUT              evidence. The leader answered and the validators did
#                        not finish in time, which is what running out of
#                        agreement looks like.
#   FINISHED_WITH_ERROR  evidence. The round ran and broke.
#   NOT_VOTED            noise. The round was accepted and never picked up.
#                        Retrying the identical probe frequently succeeds.
#   REVERTED             noise, and usually the caller's own fault: gas, or
#                        arguments the contract refused before any round began.
#
# All four are kept, because a record that quietly drops what it finds
# inconvenient is worth nothing. Only the first two shape the frontier.
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
    """Text of an exact length, for isolating size from content.

    A probe that fetches a real page measures two things at once: how big the
    payload is and how hard that particular page is to read. This measures only
    the first. It is deliberately dull, repetitive prose rather than random
    characters, because a wall of noise is not what a real round carries and
    would not cost a model the same effort to read.
    """
    unit = ("The record states the figure and the date it was taken, and the "
            "note beside it repeats the figure so the two can be compared. ")
    if size <= 0:
        return ""
    times = (size // len(unit)) + 1
    return (unit * times)[:size]


def _fields_bound(count: int) -> list:
    return FIELDS[:max(1, min(len(FIELDS), int(count)))]


def _answers_agree(leader, mine, bound: list) -> bool:
    """The agreement condition, in code rather than in a paragraph.

    Only the bound fields are compared, and they are compared exactly. Anything
    outside the bound set may differ freely, which is the point: the experiment
    is about what happens as that set grows.
    """
    if not isinstance(leader, dict) or not isinstance(mine, dict):
        return False
    if leader.get("ok") != mine.get("ok"):
        return False
    if not leader.get("ok"):
        return True
    for field in bound:
        if str(leader.get(field, "")) != str(mine.get(field, "")):
            return False
    return True


class Assay(gl.Contract):
    # A run that agreed, written by the round itself.
    runs: DynArray[str]
    # A run that did not, attested afterwards with its transaction hash.
    reports: DynArray[str]

    def __init__(self) -> None:
        pass

    # ------------------------------------------------------------- the probe

    def _task(self, page: str, bound_text: str) -> str:
        """Built from arguments only, reading no storage.

        Nothing here touches `self` state. Reading contract storage from inside
        the nondeterministic block ends the transaction on this network while
        Studio allows it, reported as genvm-manager#22, and a measurement tool
        that tripped over the thing it exists to measure would be a poor joke.
        """
        return (
            "Read the document below and answer four questions about it. "
            "Answer briefly and in the exact vocabulary given.\n\n"
            "<document>\n" + page + "\n</document>\n\n"
            "topic: one of " + ", ".join(TOPICS) + "\n"
            "language: the language the document is written in, one English "
            "word, capitalised, for example English or Turkish\n"
            "has_code: true if the document contains source code, otherwise "
            "false, as a JSON boolean\n"
            "tone: one of " + ", ".join(TONES) + "\n\n"
            "Other validators are answering the same questions about the same "
            "document, and these fields have to match theirs exactly: "
            + bound_text + ". Answer them the way the plainest reading of the "
            "document supports, not the most interesting one.\n\n"
            "Return ONLY a JSON object of exactly this shape:\n"
            '{"topic": "SOFTWARE", "language": "English", "has_code": true, '
            '"tone": "NEUTRAL"}\n'
            "Return ONLY the JSON."
        )

    def _parse(self, raw: str) -> dict:
        """Never raises. This runs inside the block, where the deterministic
        frame cannot catch an exception, so a refusal comes back as data."""
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

        topic = str(parsed.get("topic", "")).strip().upper()
        tone = str(parsed.get("tone", "")).strip().upper()
        language = str(parsed.get("language", "")).strip().title()
        has_code = parsed.get("has_code", None)

        if topic not in TOPICS:
            return {"ok": False, "why": "unknown topic " + topic[:30]}
        if tone not in TONES:
            return {"ok": False, "why": "unknown tone " + tone[:30]}
        if not isinstance(has_code, bool):
            # A JSON boolean, not a string. bool("false") is True in Python, so
            # accepting a string here would let "false" mean true, which is a
            # defect this project has already been caught by once.
            return {"ok": False, "why": "has_code must be a JSON boolean"}
        if language == "":
            return {"ok": False, "why": "no language given"}

        return {
            "ok": True,
            "topic": topic,
            "language": language,
            "has_code": has_code,
            "tone": tone,
        }

    @gl.public.write
    def probe(self, source_url: str, evidence_chars: str, bound_fields: str, mode: str) -> None:
        """One controlled round, and a record of it if it comes back.

        Anyone may run one. The result is about the network, not about the
        caller, so there is nothing to gate.
        """
        source = _http(source_url)
        try:
            size = int(evidence_chars)
        except (ValueError, TypeError):
            raise gl.vm.UserError(ERROR_EXPECTED + " evidence_chars must be a whole number")
        if size < 0 or size > MAX_EVIDENCE_CHARS:
            raise gl.vm.UserError(
                ERROR_EXPECTED + " evidence_chars must be between 0 and " + str(MAX_EVIDENCE_CHARS))

        try:
            count = int(bound_fields)
        except (ValueError, TypeError):
            raise gl.vm.UserError(ERROR_EXPECTED + " bound_fields must be a whole number")
        if count < 1 or count > len(FIELDS):
            raise gl.vm.UserError(
                ERROR_EXPECTED + " bound_fields must be between 1 and " + str(len(FIELDS)))

        chosen_mode = str(mode).strip().upper()
        if chosen_mode not in MODES:
            raise gl.vm.UserError(ERROR_EXPECTED + " mode must be STRICT or COMPARATIVE")

        bound = _fields_bound(count)
        bound_text = ", ".join(bound)
        started = _now_iso()

        def run() -> dict:
            # Fetched here, inside the block, because web access is only
            # permitted there. Truncated to the exact size being measured, and
            # padded with filler when the page is shorter than the size asked
            # for, so that what is being varied really is the payload and not
            # whichever page happened to be cited.
            try:
                page = str(gl.nondet.web.render(source, mode="text"))
            except Exception:
                page = ""
            if len(page) < size:
                page = page + _filler(size - len(page))
            page = page[:size]
            return self._parse(gl.nondet.exec_prompt(self._task(page, bound_text)))

        if chosen_mode == MODE_STRICT:
            def validator_fn(leaders_res: gl.vm.Result) -> bool:
                if not isinstance(leaders_res, gl.vm.Return):
                    return False
                return _answers_agree(leaders_res.calldata, run(), bound)

            answer = gl.vm.run_nondet_unsafe(run, validator_fn)
        else:
            # The other half of the experiment: the same agreement condition
            # described in words and handed to a model, which is what most
            # contracts in this ecosystem do. Whether the two behave the same
            # is one of the questions worth an answer.
            answer = json.loads(gl.eq_principle.prompt_comparative(
                lambda: json.dumps(run()),
                principle=(
                    "These fields must match exactly between validators: "
                    + bound_text + ", along with the ok field. Every other "
                    "field may differ freely."
                ),
            ))

        # Reached only when the round agreed. A round that timed out, was not
        # voted on, or errored never arrives here, and its transaction takes
        # this write with it, which is exactly why failures are reported
        # separately.
        self.runs.append(json.dumps({
            "run_id": str(len(self.runs)),
            "source_url": source,
            "evidence_chars": size,
            "bound_fields": count,
            "bound": bound,
            "mode": chosen_mode,
            "outcome": OUTCOME_AGREED,
            "answer": answer,
            "ran_by": _addr(gl.message.sender_address.as_hex),
            "started_at": started,
            "recorded_at": _now_iso(),
        }))

    # --------------------------------------------------- reporting a failure

    @gl.public.write
    def report_failure(self, tx_hash: str, source_url: str, evidence_chars: str,
                       bound_fields: str, mode: str, outcome: str, note: str) -> None:
        """Records a probe that never came back, with the hash that proves it.

        This is a claim, and the contract says so rather than dressing it up.
        It cannot read a receipt from inside itself, so it cannot check that the
        cited transaction failed, or that it was even a probe. What it can do is
        insist that a hash is there, keep it beside the numbers, and expose the
        two separately from the runs it recorded itself. Anybody can look the
        hash up.
        """
        digest = str(tx_hash).strip().lower()
        if not digest.startswith("0x") or len(digest) != TX_HASH_LEN:
            raise gl.vm.UserError(
                ERROR_EXPECTED + " A failure has to cite the transaction hash of the probe")
        result = str(outcome).strip().upper()
        if result not in REPORTABLE:
            raise gl.vm.UserError(
                ERROR_EXPECTED + " outcome must be one of " + ", ".join(REPORTABLE))

        for raw in self.reports:
            if json.loads(raw)["tx_hash"] == digest:
                raise gl.vm.UserError(ERROR_EXPECTED + " That transaction is already reported")

        self.reports.append(json.dumps({
            "report_id": str(len(self.reports)),
            "tx_hash": digest,
            "source_url": str(source_url)[:MAX_URL],
            "evidence_chars": int(evidence_chars),
            "bound_fields": int(bound_fields),
            "mode": str(mode).strip().upper(),
            "outcome": result,
            "note": str(note)[:300],
            "reported_by": _addr(gl.message.sender_address.as_hex),
            "reported_at": _now_iso(),
            "verify": "read the receipt for tx_hash; this contract cannot",
        }))

    # -------------------------------------------------------------- readings

    @gl.public.view
    def get_frontier(self) -> str:
        """The answer a builder actually came for.

        For each number of bound fields and each mode: the largest payload that
        has ever agreed, and the smallest that has ever failed. Where those two
        meet is the edge, and how many observations sit behind each is reported
        beside it, because three measurements are not a law and this should not
        be read as one.
        """
        rows = {}

        def slot(mode: str, count: int) -> dict:
            key = str(mode) + ":" + str(count)
            if key not in rows:
                rows[key] = {
                    "mode": mode, "bound_fields": count,
                    "largest_agreed": None, "smallest_failed": None,
                    "agreed": 0, "failed": 0, "set_aside": 0,
                }
            return rows[key]

        for raw in self.runs:
            run = json.loads(raw)
            row = slot(run["mode"], run["bound_fields"])
            row["agreed"] += 1
            size = int(run["evidence_chars"])
            if row["largest_agreed"] is None or size > row["largest_agreed"]:
                row["largest_agreed"] = size

        for raw in self.reports:
            report = json.loads(raw)
            row = slot(report["mode"], report["bound_fields"])
            size = int(report["evidence_chars"])
            # Only a failure that says something about agreement moves the
            # frontier. A round the network never voted on is a fact about the
            # queue, not about how much validators can read, and letting it in
            # here would put the edge below payloads that demonstrably agree.
            if report["outcome"] in COUNTS_AGAINST_AGREEMENT:
                row["failed"] += 1
                if row["smallest_failed"] is None or size < row["smallest_failed"]:
                    row["smallest_failed"] = size
            else:
                row["set_aside"] += 1

        out = []
        for key in sorted(rows.keys()):
            row = rows[key]
            row["observations"] = row["agreed"] + row["failed"]
            row["settled"] = (row["largest_agreed"] is not None
                              and row["smallest_failed"] is not None
                              and row["largest_agreed"] < row["smallest_failed"])
            out.append(row)
        return json.dumps({
            "frontier": out,
            "fields_in_order": FIELDS,
            "counts_against_agreement": COUNTS_AGAINST_AGREEMENT,
            "caution": ("a largest_agreed is a payload that agreed at least once, not one that "
                        "always will; a smallest_failed is one that failed at least once. Read "
                        "observations before reading anything else"),
            "set_aside_means": ("rounds that failed for a reason that says nothing about "
                                "agreement, NOT_VOTED or REVERTED. They are kept and shown, "
                                "and they do not move the frontier"),
        })

    @gl.public.view
    def get_runs(self) -> str:
        return json.dumps([json.loads(r) for r in self.runs])

    @gl.public.view
    def get_reports(self) -> str:
        return json.dumps([json.loads(r) for r in self.reports])

    @gl.public.view
    def get_stats(self) -> str:
        by_mode = {}
        for raw in self.runs:
            mode = json.loads(raw)["mode"]
            by_mode[mode] = by_mode.get(mode, 0) + 1
        return json.dumps({
            "rounds_that_agreed": len(self.runs),
            "rounds_reported_failed": len(self.reports),
            "agreed_by_mode": by_mode,
            "fields_in_order": FIELDS,
            "modes": MODES,
            "max_evidence_chars": MAX_EVIDENCE_CHARS,
            "how_to_read_this": (
                "rounds_that_agreed were written by the rounds themselves and cannot be faked. "
                "rounds_reported_failed are attested afterwards with a transaction hash, because "
                "a round that fails has its state change discarded and cannot record anything"),
        })
