# Courtscan

**Every verdict on GenLayer, and whether it actually stands.**

A block explorer shows you a finalised transaction. It does not tell you the one
thing that matters about a consensus round: did the validators agree, or did the
leader answer perfectly well and the round get thrown away anyway?

Those two look identical on an explorer. One is a verdict. The other is a verdict
that never happened.

* **Live:** open it, paste a round id, no wallet and no account
* **Assay contract:** [`0xbaBf2796De591Dfe9289b60bE68f4426449676fA`](https://explorer-asimov.genlayer.com/address/0xbaBf2796De591Dfe9289b60bE68f4426449676fA) on GenLayer Asimov, chain id 4221

---

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

What differed in the contract that failed: it bound three fields, one of them a
judgement rather than an observation, and it carried a history of earlier
decisions in the prompt. So the lever is more likely to be **what validators are
required to match, and how much room two honest models have to differ on it**,
rather than how much text they were handed.

That is now the axis being measured, and it is exactly why the lab exists: an
assumption held by one builder from one contract is not a finding, and it was
wrong.

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
