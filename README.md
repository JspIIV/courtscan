# Courtscan

**Every verdict on GenLayer, and whether it actually stands.**

A block explorer shows you a finalised transaction. It does not tell you the one
thing that matters about a consensus round: did the validators agree, or did the
leader answer perfectly well and the round get thrown away anyway?

Those two look identical on an explorer. One is a verdict. The other is a verdict
that never happened.

* **Live:** [courtscan-five.vercel.app](https://courtscan-genlayer.vercel.app) — paste a round id, no wallet and no account
* **Assay contract:** [`0xbaBf2796De591Dfe9289b60bE68f4426449676fA`](https://explorer-asimov.genlayer.com/address/0xbaBf2796De591Dfe9289b60bE68f4426449676fA) on GenLayer Asimov, chain id 4221

---


**A case is linkable.** `?round=0x…` and `?address=0x…` open that record
directly, and looking one up or clicking one in a table puts it in the address
bar. This was missing for longer than it should have been: a link of that form
had already been handed out as evidence and quietly opened the front page
instead, because nothing read the query string. A case record nobody can cite is
half a record.

**A case is linkable.** `?round=0x…` and `?address=0x…` open that record
directly, and looking one up or clicking one in a table puts it in the address
bar. This was missing for longer than it should have been: a link of that form
had already been handed out as evidence and quietly opened the front page
instead, because nothing read the query string. A case record nobody can cite is
half a record.

## Verification, and what it caught

A steward objected that unverified failure reports and malformed model outputs
could distort the published agreement frontier. Both were true, and one of them
had already happened.

**Reports are now checked against their receipts.** Assay cannot read a receipt
from inside itself, so `report_failure` takes a transaction hash and a claimed
outcome and can check neither. `scripts/verify_reports.mjs` fetches each cited
transaction, confirms it was sent to Assay, and **takes the outcome from the
receipt rather than from the label it was filed under**. Only outcomes that bear
on agreement, `NO_MAJORITY` and `DISAGREEMENT`, may move the frontier. `TIMEOUT`
is about speed, `NOT_VOTED` about the queue, and `FINISHED_WITH_ERROR` about the
contract; letting those move it would put the edge below payloads that
demonstrably agree.

The first run found one of our own reports filed as `REVERTED` whose receipt
says `NO_MAJORITY`: the validators could not reach a majority, which is
agreement actually breaking, parked in a bucket the frontier sets aside. **The
page had been claiming nothing ever broke.** It now shows the break, at 3,500
characters with one bound field, along with every report and whether it was
mislabelled.

**One implementation, and the published path goes through it.** The indexer used
to carry its own copy of the classifier and the rate, so fixing the tested copy
left the published sample using the old one. `scripts/courtscan_index.mjs` and
the page now both import `app/src/decode.js`, and the tests cover exactly the
code that runs.

**Reports are bound to the calls they cite.** A report names a payload size and a
bound field count, and nothing stopped it naming numbers belonging to a different
probe. Those numbers are the axes the frontier is drawn on, so a wrong one is not
a detail, it is a measurement of something else entered on this chart. The
dimensions now come out of the probe's own calldata and a report that disagrees
is rejected.

Doing that needed a real calldata decoder rather than the heuristic one, which
read method names correctly and returned empty argument lists. GenLayer tags each
value with a LEB128 varint whose low three bits are the type and whose remainder
is a length: type 4 string, 5 array, 6 map, with map keys carrying a plain length
byte instead. The asymmetry is what the heuristic missed.

**The page publishes the verified frontier**, built from receipts and calldata,
not the contract's own `get_frontier`, which is assembled from whatever labels
reports arrived with. One of ours was wrong, so publishing that one would have
been publishing the error.

**A correction worth recording.** The first attempt at excluding parse failures
excluded every round on the network: it treated "not JSON" as undecodable, and
most contracts return a tagged value that is not JSON and never meant to be. A
rate computed that way is not stricter, it is empty. Readability now has three
states, and the placeholder the node writes for rounds with no equivalence block
at all, an eight byte value containing the word `padded`, is one of them.

**Undecodable rounds no longer count as agreement.** A round whose leader output
cannot be decoded is counted, reported, and kept out of the rate entirely. The
validators may well have agreed, but a rate published as how often the network
agrees on an answer cannot include rounds where nobody can say what the answer
was.

**The decoder has fixtures and invariant tests.** `npm test` runs fifteen checks
with no network, against raw receipts captured from Asimov in `tests/fixtures`.
They cover the real cases and the properties: padding is never reported as
something the leader said, an undecodable round cannot move the rate in either
direction, the rate always lies between 0 and 1, it is null rather than zero
when nothing can be counted, and every round lands in exactly one bucket.

These run offline on purpose. They are the properties that must hold on the days
the testnet is unwell, and a test needing a healthy chain is skipped on exactly
those days.


## The case, in one round

This round is real and you can look it up in Courtscan right now:

```
0x938a593d62056696702c5db81a7f61c487a970ddfc4f1eece34e676062d21545
```

The official explorer reports it as **FINALIZED**. Read that and you would
conclude a decision was made. What actually happened:

```
status FINALIZED   result TIMEOUT   execution FINISHED_WITH_RETURN

what the leader said, which was then discarded:
{"ok": true, "decision": "WARN", "precedent": "none",
 "holding": "An agent must not exceed its weekly budget, even when doing so
             serves the stated purpose of the mandate..."}
```

A supervisor contract reviewed an agent's conduct, its leader reached a
considered answer, the validators did not finish in time, and the answer was
thrown away. The transaction finalised anyway. Nothing was decided, and nothing
about the transaction says so unless you know to read three separate fields and
know which one wins.

That is the gap Courtscan fills.

## What it does

**Look up a round.** Paste a round id and get the outcome in a sentence, what the
leader said, and whether it survived. Paste a contract address and get its rounds
from the current sample.

**Watch rounds happen.** The last 150 blocks of consensus events, decoded in the
browser as you load the page.

**See the network's own numbers.** A sampled agreement rate across every contract
in a window of blocks. As far as I can find, that figure has not been published
anywhere.

**And a laboratory.** Watching rounds tells you what happened; it does not tell
you what makes a round fail, because the payload inside somebody else's contract
is invisible from outside. So `contracts/assay.py` runs controlled rounds on
purpose: a page cut to an exact size, an exact number of fields required to
match, and a record of where agreement stops.

## What the two halves found, and what they corrected

**The network agrees almost always.** A sample of several hundred rounds across
every contract in a window of blocks comes back at roughly 99.7% agreement. So a
round that fails is not evidence of an unwell network. It is evidence about the
round.

**And the first thing measured contradicted the person measuring it.** The
project was started on the belief that payload size was the lever, because a
supervisor contract of mine had timed out at 8,000 characters of evidence and
succeeded at 3,500. That is in the git history of another repository and it felt
like a law.

It is not one. A probe with **12,000 characters and one bound field agreed
without difficulty.** Size alone did not break anything up to the ceiling this
contract allows.

Binding was the next suspect, and it has not held up either: **four bound
fields at 1,500 characters agreed too.** So neither axis this contract can vary
has yet produced a single agreement failure.

**The lab has not reproduced a failure. That is the current state and it is
stated rather than dressed up.** Every frontier row reads "not found yet"
because nothing has been bracketed. A tool that measures where agreement breaks
and has not yet made it break is a tool with an honest zero in it, and the site
shows that zero.

What is left, and the likeliest answer: the probe asks validators to *classify* a
document into four short fields. The contract that failed asked them to *write* a
judgement, with a decision, a named precedent and a sentence of holding composed
on the spot. Generating prose under a clock is a different cost from choosing
from a list. If that is the lever, then the thing that breaks rounds is not how
much validators read or how many fields they must match, but how much they have
to compose. That is a hypothesis with one supporting case, and it is the next
axis to build into the probe.

Both numbers are on the site, side by side, with the count of observations behind
each. Neither is presented as a law, including this one.

## How rounds are found

Every GenLayer transaction passes through the consensus contract, which emits
events as a round moves. The ABI for those events is not published anywhere I
could find, so the indexer does not pretend to decode them by name. It does
something cruder and more honest: it takes every 32 byte value out of every
topic, tries it as a round id, and keeps the ones the node recognises.

A byproduct worth having, discovered by trying rather than by documentation:
which event signatures actually carry round ids. That map is written out with
every sample in `app/public/sample.json`.

The node caps a log query at 10,000 results and answers `Internal error` rather
than saying so, which is how the first wide scan failed. Windows now halve until
they come back.

## The one asymmetry, stated plainly

A round that fails does not get to write anything down. Consensus discards the
state change, so a contract cannot record "I timed out": the record would be part
of the transaction that was thrown away.

So in Assay the two halves of a measurement have different standing, and the
difference is shown rather than smoothed over:

| | |
|---|---|
| a round that agreed | the contract wrote it itself, inside the round. Nobody can put a false success there, because writing at all required agreement |
| a round that did not | attested afterwards by whoever ran it, citing the transaction hash. The contract cannot check that. Anybody can, and every row links to the receipt |

## Three mistakes this made, and what they were

Kept here because a measurement tool that hides its own errors is worth nothing.

**Scheduling noise counted as failure.** The first probes reported a 500
character round as failed and a 3500 character one as agreed, which would put the
frontier below a payload that demonstrably works. The 500 round was `NOT_VOTED`:
the network never picked it up. That says nothing about agreement. `TIMEOUT` and
`FINISHED_WITH_ERROR` now shape the frontier; `NOT_VOTED` and `REVERTED` are kept
and shown but set aside.

**An unknown recorded as a fact.** A probe got no answer for ten minutes and the
harness wrote `REVERTED` on chain. A transaction still settling and one that never
ran look identical from outside, and guessing between them put a claim on chain
that nothing supported. It now reports nothing and says the network has not said
yet.

**Padding shown as speech.** The equivalence outputs are padded, and the padding
decodes to plausible looking words. The live feed briefly displayed `padded` in a
column headed "what the leader said", which is putting words in its mouth: the
exact failure the whole project is about. Nothing is shown now unless a real
object can be read out of the bytes.

## Running it

Nothing on the site needs a wallet. These are for taking your own measurements.

```bash
npm install

# Sample the network: decode recent rounds and write app/public/sample.json
BLOCKS=4000 MAX_ROUNDS=300 npm run index

# Serve the site against your sample
npm run dev
```

Running a probe writes to the chain, so it needs a funded Asimov account. Either
source works, and neither is hard coded:

```bash
# a private key
ASSAY_KEY=... SWEEP=size npm run probe

# or a keystore, wherever you keep it
ASSAY_KEYSTORE_DIR=~/.genlayer/keystores ASSAY_KEYSTORE_PASS=... SWEEP=size npm run probe
```

Sweeps: `quick`, `size`, `binding`, `modes`. `binding` and `modes` are the ones
with the least data behind them so far, so they are the most worth adding to.

## The site writes nothing, on purpose

`assay.py` has two write methods, `probe` and `report_failure`, and there is no
button for either. That is deliberate rather than an oversight, and it is said
here so nobody has to wonder.

Courtscan is a read. Every figure on the page comes from the chain and needs no
wallet, no account and no GEN, which is the whole reason a stranger can use it
at all. Taking a measurement is a different act: it costs gas, it takes minutes,
and it belongs to whoever is running the experiment. That lives in
`scripts/assay_sweep.mjs`, which sends the probe, reads the receipt, and reports
a failure back with its transaction hash.

Both write paths are exercised there and the results are on chain at the Assay
address above.

## Honest limits

The sample is a window of blocks, not the chain. The agreement rate is over
rounds that had settled when the sample was taken.

Contract lookup only searches the current sample, so "no rounds" means "not in
that window", never "never". A round id can always be looked up directly, live.

The lab has few observations. The frontier is shown with the count beside it and
a note saying so, and a frontier that has not actually been bracketed says that
too. It is a beginning, not a result.

This reads Asimov. Bradbury and Clarke would each need their own sample, and the
figures should not be assumed to carry across.

And the largest limit, repeated because it matters more than the rest: the
laboratory has not yet made a round fail on purpose. Every failure it has
recorded is scheduling noise, set aside from the frontier. The one real
agreement failure behind this whole project happened in the wild, in a contract
doing something the probe does not yet do.

## Round shapes: which kinds of round actually land

Courtscan reads rounds other contracts happened to produce. `contracts/roundshapes.py`
produces them on purpose, in three shapes, so the difference can be counted
rather than guessed at.

Same URL, same storage write, same return shape in all three. The only thing
that varies is what the round contains.

Live on GenLayer Studionet at `0x6E3589463f576C02ed4929C139353b49E6d1cdcE`.
Raw dataset: [`results/round_shapes.json`](results/round_shapes.json).

| shape | landed | median | spread |
|---|---|---|---|
| deterministic, no round | 8 of 8 | 40s | 38 to 44 |
| one web fetch under `strict_eq` | 8 of 8 | 41s | 35 to 45 |
| the same fetch, then one model question | 8 of 8 | 56s | 44 to 77 |

**Twenty four of twenty four landed. None failed.** Across those rounds the
validators cast 58 `agree` votes and 38 `idle`, so roughly two in five validator
slots sat out without that costing a single round.

**This corrects something we had published.** Working on other contracts we saw a
round that fetched a page and then reasoned over it come back `TIMEOUT`, and we
wrote that up as a property of rounds that do both. It is not. That timeout was
on testnet-asimov, over a page of fetched text with a long question attached. On
Studionet, with a small document and a one sentence question, the same shape
lands every time.

What the measurement does support is narrower and duller: reasoning costs about
fifteen seconds at the median, and much more than that at the tail. The slowest
deterministic round finished in 44 seconds and the slowest reasoning round took
77. Splitting fetching from reasoning is still worth doing for a contract that
moves money, because the tail is where a round runs out of budget, but the
justification is variance rather than certain failure.

The anecdote was one observation. This is twenty four, and it disagrees with us.
