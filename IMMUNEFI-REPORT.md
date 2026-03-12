# Immunefi Bug Report — DeXe Protocol

> This document contains the complete content for the Immunefi dashboard submission.
> Each section corresponds to a field in the submission form.

---

## FIELD: Program

DeXe Protocol

## FIELD: Asset

PoolFactory — `0x85f86ef7E72e86BdEAb5F65e2B76A2c551f22109` (BSC)

## FIELD: Impact

Manipulation of governance voting result

## FIELD: Severity

Critical

---

## FIELD: Title

Severity Escalation of Cyfrin M-09: Batch Treasury Exemption Enables Near-Zero Quorum and Full Governance Takeover

---

## FIELD: Bug Description

### Context: Cyfrin Audit Finding M-09

We are aware of Cyfrin audit finding M-09 ("Users can use delegated treasury voting power to vote on proposals that give them more delegated treasury voting power") and DeXe's mitigation in PR #168, which replaced `_restrictInterestedUsersFromProposal()` with `_exemptUserTreasuryFromVoting()` and `_calculateNewQuorum()`.

Cyfrin's mitigation review (Section 7.3.9, p. 50 of [`audits/cyfrin-2023-11-10.pdf`](https://github.com/dexe-network/DeXe-Protocol/blob/master/audits/cyfrin-2023-11-10.pdf)) explicitly noted: *"Dexe has not fully implemented the recommendation that: 'they can never use this power to vote on proposals that increase/decrease this power, for themselves or for other users.'"* Cyfrin continued to recommend full prohibition. DeXe marked this as **"Acknowledged"**.

**This report demonstrates that the impact of this acknowledged issue is significantly more severe than the original Medium classification suggests — it enables a full governance takeover.**

### The Underestimated Attack Vector

The original Cyfrin finding focused on a **conflict-of-interest** scenario: Expert A voting on Expert B's delegation changes. This was assessed as Medium severity.

However, the actual exploitable scenario is far worse:

1. **Any proposal creator** (not just experts) can target **all** treasury-delegated experts simultaneously in a single proposal
2. This reduces the quorum **proportionally to the total treasury ratio** — potentially to near-zero
3. All targeted experts' **treasury voting power is excluded** from the proposal (they can still vote with personal tokens, but lose the dominant portion of their influence)
4. The only guard is `assert(settings.quorum > 0)`, which merely prevents the quorum from reaching exactly zero

### Precise Voting Mechanics

When `treasuryExemptProposals` includes a proposal ID for a user, [`_voteDelegated()`](https://github.com/dexe-network/DeXe-Protocol/blob/f09a3ba98c2e44c5c026667bb1a1495db74f6ee3/contracts/libs/gov/gov-pool/GovPoolVote.sol#L159-L171) returns early for `TreasuryVote`, and [`_calculateVotes()`](https://github.com/dexe-network/DeXe-Protocol/blob/f09a3ba98c2e44c5c026667bb1a1495db74f6ee3/contracts/libs/gov/gov-pool/GovPoolVote.sol#L383-L411) sets treasury power to zero. Experts can still vote with `PersonalVote` and `MicropoolVote` types, but in practice their treasury delegation constitutes the dominant portion of their voting influence.

### Root Cause

[`_calculateNewQuorum()`](https://github.com/dexe-network/DeXe-Protocol/blob/f09a3ba98c2e44c5c026667bb1a1495db74f6ee3/contracts/libs/gov/gov-pool/GovPoolCreate.sol#L319-L329) applies the exemption proportionally with no floor:

```solidity
function _calculateNewQuorum(
    uint256 quorum,
    uint256 exemptedTreasury
) internal view returns (uint256) {
    (, address userKeeper, , , ) = IGovPool(address(this)).getHelperContracts();
    uint256 totalVoteWeight = IGovUserKeeper(userKeeper).getTotalPower();
    uint256 newTotalVoteWeight = (totalVoteWeight - exemptedTreasury).percentage(quorum);
    return PERCENTAGE_100.ratio(newTotalVoteWeight, totalVoteWeight);
}
```

The formula `newQuorum = originalQuorum * (totalVoteWeight - exemptedTreasury) / totalVoteWeight` has no minimum bound. When `exemptedTreasury` approaches `totalVoteWeight`, the quorum approaches zero.

### Why This Exceeds Medium Severity

The Cyfrin finding described: "Expert A can vote on proposals about Expert B." That is a conflict of interest — Medium severity.

What actually happens when exploited at scale:

- **Any user** (not just experts) creates a proposal with `undelegateTreasury` for every expert
- In a DAO with 80% treasury delegation: quorum drops from 51% to **10.2%**
- In a DAO with 90% treasury delegation: quorum drops from 51% to **5.1%**
- Simultaneously, all experts' **treasury voting power is excluded** — the dominant portion of their influence is removed (personal/micropool votes remain but are typically negligible by comparison)
- A small minority can pass any governance action — treasury withdrawals, parameter changes, minting NFTs

This is not a conflict of interest. This is a **governance takeover vector**.

### Affected Code Locations

All links pinned to commit [`f09a3ba`](https://github.com/dexe-network/DeXe-Protocol/tree/f09a3ba98c2e44c5c026667bb1a1495db74f6ee3):

| File | Function | Permalink |
|------|----------|-----------|
| `GovPoolCreate.sol` | `_exemptUserTreasuryFromVoting()` | [L163-204](https://github.com/dexe-network/DeXe-Protocol/blob/f09a3ba98c2e44c5c026667bb1a1495db74f6ee3/contracts/libs/gov/gov-pool/GovPoolCreate.sol#L163-L204) |
| `GovPoolCreate.sol` | `_calculateNewQuorum()` | [L319-329](https://github.com/dexe-network/DeXe-Protocol/blob/f09a3ba98c2e44c5c026667bb1a1495db74f6ee3/contracts/libs/gov/gov-pool/GovPoolCreate.sol#L319-L329) |
| `GovPoolVote.sol` | `_quorumReached()` | [L370-374](https://github.com/dexe-network/DeXe-Protocol/blob/f09a3ba98c2e44c5c026667bb1a1495db74f6ee3/contracts/libs/gov/gov-pool/GovPoolVote.sol#L370-L374) |
| `GovPoolVote.sol` | `_voteDelegated()` (treasury exclusion) | [L159-171](https://github.com/dexe-network/DeXe-Protocol/blob/f09a3ba98c2e44c5c026667bb1a1495db74f6ee3/contracts/libs/gov/gov-pool/GovPoolVote.sol#L159-L171) |

### Gap in Existing Test Coverage

DeXe's own test suite ([`GovPool.test.js` L1522-1601](https://github.com/dexe-network/DeXe-Protocol/blob/f09a3ba98c2e44c5c026667bb1a1495db74f6ee3/test/gov/GovPool.test.js#L1522-L1601)) tests the exempted treasury mechanism for 1-2 experts only. It does not test:

- Targeting all experts simultaneously
- Quorum reduction to near-zero levels
- Whether a minority can pass proposals via the reduced quorum

---

## FIELD: Impact

### Governance Takeover

This vulnerability enables **manipulation of governance voting outcomes** by reducing the quorum to a fraction of its intended value. This directly maps to the Critical impact: *"Manipulation of governance voting result deviating from voted outcome."*

### Quantified Impact — PoC Results

**Scenario 1: 27% treasury delegation (Tests 1-4)**

| Metric | Before Attack | After Attack |
|--------|---------------|--------------|
| Quorum | 51% | 37% |
| Votes needed | 5,661 tokens | 4,107 tokens |
| Reduction | — | **27% fewer votes needed** |
| Expert treasury power | Active | **Excluded from proposal** |

A 45% minority passes a proposal that would normally require 51%.

**Scenario 2: 80% treasury delegation (Test 5 — Full E2E Takeover)**

| Metric | Before Attack | After Attack |
|--------|---------------|--------------|
| Quorum | 10% | **2%** |
| Attacker stake | 4% (500 tokens) | **Passes vote alone** |
| Reduction factor | — | **5x** |
| Expert treasury power | Active | **80% treasury voting power excluded** |
| Treasury undelegated | — | **10,000 tokens** |

A **4% minority** creates, votes on, and executes a governance proposal — a complete takeover.

### Scaling With Treasury Ratio

The DeXe whitepaper explicitly describes treasury delegation as a mechanism to raise quorums from ~5% to 50%+. As DAOs adopt this feature, the attack surface grows:

| Treasury Ratio | Original Quorum | Reduced Quorum | Reduction Factor |
|----------------|-----------------|----------------|------------------|
| 20% | 51% | 40.8% | 1.25x |
| 40% | 51% | 30.6% | 1.67x |
| 60% | 51% | 20.4% | 2.5x |
| 80% | 10% | **2%** | **5x** (PoC verified) |
| 90% | 51% | 5.1% | **10x** |

### Current State and Future Risk

No GovPool on BSC currently has active treasury delegations (verified by querying `delegations()` on the `GovUserKeeper` of all 140 registered GovPools via BSC RPC — all returned `power = 0`).

However:

- Treasury delegation is **a core strategic feature** per the [DeXe whitepaper](https://whitepaper.dexe.network/dexe-protocol-overview/delegated-governance) and roadmap
- The mechanism is fully deployed and functional in all **140 GovPools** (verified via `PoolRegistry.countPools("GOV_POOL")` on [`0xFEB26AAB75638440B3CEFe8B10de6118972f9C6B`](https://bscscan.com/address/0xFEB26AAB75638440B3CEFe8B10de6118972f9C6B))
- The DeXe DAO GovPool ([`0xB562127...`](https://bscscan.com/address/0xB562127efDC97B417B3116efF2C23A29857C0F0B)) holds ~49.8M DEXE across chains (~48.5M on Ethereum, ~1.3M on BSC), valued at ~$208M at current prices (~$4.18 per DEXE)
- Once any DAO activates treasury delegation, this vulnerability becomes exploitable

### Consequential Damage via Governance Takeover

Once quorum is reduced, an attacker can pass proposals to:
- Withdraw treasury funds
- Permanently lower quorum via `editSettings`
- Mint unauthorized expert NFTs
- Modify critical protocol parameters

---

## FIELD: Proof of Concept

### Setup

```bash
git clone https://github.com/dexe-network/DeXe-Protocol.git
cd DeXe-Protocol
npm install
```

Add BSC fork configuration to `hardhat.config.js` in the `hardhat` network section:

```javascript
hardhat: {
  initialDate: "1970-01-01T00:00:00Z",
  forking: process.env.BSC_FORK
    ? {
        url: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org/",
        blockNumber: process.env.BSC_FORK_BLOCK
          ? parseInt(process.env.BSC_FORK_BLOCK)
          : undefined,
      }
    : undefined,
},
```

### Running the PoC (BSC Mainnet Fork)

```bash
BSC_FORK=true npx hardhat test test/gov/QuorumManipulationForkPoC.test.js
```

### Expected Output

```
  PoC: Treasury Exemption Quorum Manipulation (BSC Fork)
    Attack Scenario
      ✔ should show quorum is dramatically reduced when targeting all experts
      ✔ should show a normal proposal keeps full quorum
      ✔ should demonstrate that votes needed to pass are dramatically reduced
      ✔ should execute full attack: minority passes and executes proposal
         that would fail under normal quorum
    Extreme Scenario: ~80% Treasury — Tiny Minority Governance Takeover
      ✔ should allow a ~4% minority to fully take over governance
         (quorum drops from 10% to ~2%)

  5 passing (54s)
```

### Key Test Results

**Test 4 — End-to-End Attack (27% treasury):** A 45% minority passes a proposal that requires 51% quorum, because the quorum is reduced to 37%. The proposal executes and 3000 tokens are undelegated from experts.

**Test 5 — Extreme Scenario (80% treasury):** A **4% minority** creates and passes a proposal, exploiting an 80% treasury delegation:

| Metric | Value |
|--------|-------|
| Treasury ratio | 80% (10,000 of 12,500 tokens) |
| Original quorum | 10% |
| Reduced quorum | **2%** (5x reduction) |
| Attacker's stake | 4% (500 tokens) |
| Expert treasury power | 4 experts' treasury voting power excluded |
| Result | 10,000 treasury tokens undelegated |

The attacker's 4% vote **fails** under the normal 10% quorum but **passes** under the manipulated 2% quorum. The proposal executes successfully.

### PoC Test File

The complete PoC test is located at `test/gov/QuorumManipulationForkPoC.test.js`.

### Attack Steps

1. Attacker identifies all experts with treasury delegation in a GovPool
2. Attacker creates a single proposal containing `undelegateTreasury` actions for every expert
3. `_exemptUserTreasuryFromVoting()` accumulates all experts' treasury power as `exemptedTreasury`
4. `_calculateNewQuorum()` reduces the proposal's quorum with no floor: `newQuorum = 51% * (1 - treasuryRatio)`
5. All targeted experts are added to `treasuryExemptProposals` — their treasury voting power is excluded (personal tokens remain but are typically negligible)
6. The proposal requires dramatically fewer votes to pass
7. Attacker (or a colluding minority) votes to reach the reduced quorum
8. Proposal passes validators and executes

---

## FIELD: Recommendation

### Option A: Enforce a Minimum Quorum Floor (Recommended)

Add a minimum quorum bound in `_calculateNewQuorum()` to prevent the quorum from dropping below a safe threshold:

```solidity
function _calculateNewQuorum(
    uint256 quorum,
    uint256 exemptedTreasury
) internal view returns (uint256) {
    (, address userKeeper, , , ) = IGovPool(address(this)).getHelperContracts();

    uint256 totalVoteWeight = IGovUserKeeper(userKeeper).getTotalPower();
    uint256 newTotalVoteWeight = (totalVoteWeight - exemptedTreasury).percentage(quorum);
    uint256 newQuorum = PERCENTAGE_100.ratio(newTotalVoteWeight, totalVoteWeight);

    // Enforce minimum quorum floor — never below 50% of original
    uint256 minQuorum = quorum / 2;
    return newQuorum > minQuorum ? newQuorum : minQuorum;
}
```

### Option B: Limit Exemptions Per Proposal

Restrict the number of experts that can be exempted in a single proposal to prevent batch targeting:

```solidity
// In _exemptUserTreasuryFromVoting():
uint256 exemptedCount;
// ... inside the loop:
if (userInfos[user].treasuryExemptProposals.add(proposalId)) {
    exemptedCount++;
    require(exemptedCount <= 1, "Gov: max one treasury exemption per proposal");
    // ...
}
```

### Option C: Separate Non-Reducible Quorum for Treasury Actions

Create a dedicated quorum setting for treasury-related proposals that is not subject to the exemption reduction mechanism.

### Note on `assert(settings.quorum > 0)`

The current guard only prevents quorum from reaching exactly zero. A quorum of 1 (effectively 0.000000000000000000000001%) is functionally equivalent to no quorum. A meaningful floor is needed.

---

## FIELD: References

- **Cyfrin Audit M-09** (Section 7.3.9, p. 50): [audits/cyfrin-2023-11-10.pdf](https://github.com/dexe-network/DeXe-Protocol/blob/master/audits/cyfrin-2023-11-10.pdf) — "Users can use delegated treasury voting power to vote on proposals that give them more delegated treasury voting power" (Status: **Acknowledged**)
- **DeXe PR #168** (Fix/quorum, commit [`01bc28e`](https://github.com/dexe-network/DeXe-Protocol/commit/01bc28e89a99da5f7b67d6645c935f7230a8dc7b)): Implementation of `_exemptUserTreasuryFromVoting()` and `_calculateNewQuorum()`
- **Affected source code** (pinned to commit [`f09a3ba`](https://github.com/dexe-network/DeXe-Protocol/tree/f09a3ba98c2e44c5c026667bb1a1495db74f6ee3)):
  - [`GovPoolCreate.sol#L163-L204`](https://github.com/dexe-network/DeXe-Protocol/blob/f09a3ba98c2e44c5c026667bb1a1495db74f6ee3/contracts/libs/gov/gov-pool/GovPoolCreate.sol#L163-L204) — `_exemptUserTreasuryFromVoting()`
  - [`GovPoolCreate.sol#L319-L329`](https://github.com/dexe-network/DeXe-Protocol/blob/f09a3ba98c2e44c5c026667bb1a1495db74f6ee3/contracts/libs/gov/gov-pool/GovPoolCreate.sol#L319-L329) — `_calculateNewQuorum()`
  - [`GovPoolVote.sol#L159-L171`](https://github.com/dexe-network/DeXe-Protocol/blob/f09a3ba98c2e44c5c026667bb1a1495db74f6ee3/contracts/libs/gov/gov-pool/GovPoolVote.sol#L159-L171) — `_voteDelegated()` treasury exclusion
  - [`GovPoolVote.sol#L370-L374`](https://github.com/dexe-network/DeXe-Protocol/blob/f09a3ba98c2e44c5c026667bb1a1495db74f6ee3/contracts/libs/gov/gov-pool/GovPoolVote.sol#L370-L374) — `_quorumReached()`
  - [`GovPool.test.js#L1522-L1601`](https://github.com/dexe-network/DeXe-Protocol/blob/f09a3ba98c2e44c5c026667bb1a1495db74f6ee3/test/gov/GovPool.test.js#L1522-L1601) — existing treasury exemption tests (1-2 experts only)
- **On-chain verification** (BSC Mainnet):
  - PoolRegistry [`0xFEB26AAB...`](https://bscscan.com/address/0xFEB26AAB75638440B3CEFe8B10de6118972f9C6B): `countPools("GOV_POOL")` = 140
  - DeXe DAO GovPool [`0xB562127e...`](https://bscscan.com/address/0xB562127efDC97B417B3116efF2C23A29857C0F0B): ~49.8M DEXE across ETH+BSC
  - Treasury delegation status: 0/140 GovPools have active delegations (verified via RPC `delegations()` queries)
- **DeXe Whitepaper**: [Delegated Governance](https://whitepaper.dexe.network/dexe-protocol-overview/delegated-governance) | [Token & Treasury](https://whitepaper.dexe.network/dexe-protocol-dao/token-and-treasury)
- **Immunefi Program**: https://immunefi.com/bug-bounty/dexeprotocol/
- **DeXe Delegation Docs**: https://docs.dexe.network/guides/interacting-with-dao/delegations
