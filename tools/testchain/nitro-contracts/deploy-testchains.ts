// @ts-nocheck -- this file runs inside a nitro-contracts checkout (Hardhat, ts-node, CommonJS, ethers v5),
// which is where its imports resolve. It is not type-checked in the registry repo.
//
// Test-chain deployer for the publish process's test-chain check (spec §5.8).
//
// The driver (tools/src/testchain/nitro-contracts.ts) copies this file into the checkout's
// scripts/ directory and runs `hardhat run --no-compile --network custom <file>` against a local
// anvil node. It:
//   1. deploys the templates and RollupCreator with the checkout's own deployAllContracts()
//      and setTemplates(), as scripts/local-deployment/deployCreatorAndCreateRollup.ts does;
//   2. deploys the contracts that optional addresses must point at (stake token, fee token,
//      fee token pricer, custom DA validator, custom OSP, validator wallet);
//   3. creates one rollup per template variant (ETH / ERC20 fee token x delay-bufferable on/off),
//      with every address-valued createRollup param set to a non-zero address;
//   4. writes the addresses as JSON to $REGISTRY_TESTCHAIN_OUT.
// On failure it writes the error's stack to $REGISTRY_TESTCHAIN_ERROR.
//
// It builds the createRollup params itself instead of calling scripts/rollupCreation.ts, because
// rollupCreation.ts imports ./config (absent in a clean checkout), always makes a delay-bufferable
// chain and hardcodes anyTrustFastConfirmer to zero.
//
// The params are checked against the creator's ABI before each call: any param this script doesn't
// know (e.g. one added at a later commit) or any address param left zero fails the deployment, so a
// new optional address can't silently go untested.

import { ethers } from 'hardhat'
import '@nomiclabs/hardhat-ethers'
import { promises as fs } from 'fs'
import { deployAllContracts, deployOneStepProofEntry } from './deploymentUtils'

const OUT = mustEnv('REGISTRY_TESTCHAIN_OUT')
const RPC_URL = mustEnv('CUSTOM_RPC_URL')
const DEPLOYER_KEY = mustEnv('CUSTOM_PRIVKEY')

// anvil's default mnemonic; accounts 1.. are used as EOA role holders.
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'
// Same default as deployCreatorAndCreateRollup.ts.
const MAX_DATA_SIZE = 117964
// Same as rollupCreation.ts.
const MAX_FEE_PER_GAS_FOR_RETRYABLES = ethers.utils.parseUnits('1', 'gwei')
// Pays for the four L2 factory retryables on ETH chains; the creator refunds the excess.
const ETH_FACTORY_DEPLOY_VALUE = ethers.utils.parseEther('1')
const ARACHNID_CREATE2_FACTORY = '0x4e59b44847b379578588920cA78FbF26c0B4956C'

const VARIANTS = [
  { name: 'eth-bufferable', variant: { feeToken: 'eth', delayBufferable: true } },
  { name: 'eth-nonbufferable', variant: { feeToken: 'eth', delayBufferable: false } },
  { name: 'erc20-bufferable', variant: { feeToken: 'erc20', delayBufferable: true } },
  { name: 'erc20-nonbufferable', variant: { feeToken: 'erc20', delayBufferable: false } },
]

// Address params that must stay zero for a variant, because the creator rejects or
// reinterprets a non-zero value there.
function zeroByDesign(feeToken) {
  return feeToken === 'eth'
    ? new Set([
        'nativeToken', // non-zero selects the ERC20 templates
        'feeTokenPricer', // SequencerInbox.initialize reverts CannotSetFeeTokenPricer on ETH chains
      ])
    : new Set()
}

// Minimal stub contracts for optional addresses whose real implementations are chain-operator
// code that nitro-contracts' build doesn't contain. Neither is called while creating a rollup.
//   pricer:      returns uint256(1e18) for any call (IFeeTokenPricer.getExchangeRate)
//   DA validator: returns uint256(1) for any call (ICustomDAProofValidator.validateCertificate -> true)
const PRICER_STUB_RUNTIME = '670de0b6b3a764000060005260206000f3'
const DA_VALIDATOR_STUB_RUNTIME = '600160005260206000f3'

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(RPC_URL)
  // ethers' default 4s polling makes each tx.wait() take seconds on a local node.
  provider.pollingInterval = 50
  const deployer = new ethers.Wallet(DEPLOYER_KEY, provider)
  const { chainId } = await provider.getNetwork()
  const eoa = (i: number) =>
    ethers.Wallet.fromMnemonic(ANVIL_MNEMONIC, `m/44'/60'/0'/0/${i}`).address

  // Same as deployCreatorAndCreateRollup.ts (anvil normally has the factory already).
  if ((await provider.getCode(ARACHNID_CREATE2_FACTORY)).length <= 2) {
    console.log('Deploying CREATE2 factory')
    await (
      await deployer.sendTransaction({
        to: '0x3fab184622dc19b6109349b94811493bf2a45362',
        value: ethers.utils.parseEther('0.01'),
      })
    ).wait()
    await (
      await provider.sendTransaction(
        '0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf31ba02222222222222222222222222222222222222222222222222222222222222222a02222222222222222222222222222222222222222222222222222222222222222'
      )
    ).wait()
  }

  // 1. Templates and RollupCreator.
  console.log('Deploy RollupCreator')
  const deployed = await deployAllContracts(
    deployer,
    deployer.address,
    ethers.BigNumber.from(MAX_DATA_SIZE),
    false
  )
  console.log('Set templates on the Rollup Creator')
  await (
    await deployed.rollupCreator.setTemplates(
      deployed.bridgeCreator.address,
      deployed.osp.address,
      deployed.challengeManager.address,
      deployed.rollupAdmin.address,
      deployed.rollupUser.address,
      deployed.upgradeExecutor.address,
      deployed.validatorWalletCreator.address,
      deployed.deployHelper.address,
      { gasLimit: ethers.BigNumber.from('300000') }
    )
  ).wait()
  const creator = deployed.rollupCreator

  const templates: Record<string, string> = {}
  for (const [key, contract] of Object.entries(deployed)) {
    if (key !== 'rollupCreator') templates[key] = contract.address
  }
  const bridgeCreator = deployed.bridgeCreator
  for (const kind of ['ethBasedTemplates', 'erc20BasedTemplates']) {
    const result = await bridgeCreator[kind]()
    for (const [key, value] of Object.entries(result)) {
      if (!/^\d+$/.test(key)) templates[`${kind}.${key}`] = value
    }
  }
  const templateSequencerInbox = await ethers.getContractAt(
    'SequencerInbox',
    templates['ethBasedTemplates.sequencerInbox'],
    deployer
  )
  templates.reader4844 = await templateSequencerInbox.reader4844()

  // 2. Contracts for the optional addresses.
  console.log('Deploying contracts for optional addresses')
  const stakeToken = await deployFromArtifact(deployer, 'TestWETH9', ['Wrapped Ether', 'WETH'])
  const feeToken = await deployFromArtifact(deployer, 'TestToken', [
    ethers.utils.parseEther('1000000000'),
  ])
  const feeTokenPricer = await deployRaw(deployer, PRICER_STUB_RUNTIME)
  const customDAValidator = await deployRaw(deployer, DA_VALIDATOR_STUB_RUNTIME)
  // A second OSP built from this checkout, with a custom DA validator, as scripts/deployOsp.ts does.
  // prover0/proverMem/proverMath have the same CREATE2 address as the templates' (same init code);
  // OneStepProverHostIo and OneStepProofEntry are new.
  const customOsp = (await deployOneStepProofEntry(deployer, customDAValidator, false)).osp.address
  if (customOsp === deployed.osp.address) throw new Error('custom OSP equals the template OSP')
  const validatorWallet = await createValidatorWallet(
    deployer,
    deployed.validatorWalletCreator.address
  )

  const roles = {
    owner: deployer.address,
    loserStakeEscrow: eoa(1),
    anyTrustFastConfirmer: eoa(2),
    validatorEoa: eoa(3),
    batchPoster: eoa(4),
    batchPosterManager: eoa(5),
  }

  // The ERC20 chains' factory retryables are paid in the fee token, pulled from the caller.
  await (await feeToken.approve(creator.address, ethers.constants.MaxUint256)).wait()

  // 3. One rollup per variant.
  const createRollup = creator.interface.getFunction('createRollup')
  if (createRollup.inputs.length !== 1) {
    throw new Error(`unexpected createRollup signature: ${createRollup.format()}`)
  }
  const chains = []
  for (const [i, { name, variant }] of VARIANTS.entries()) {
    console.log(`Creating rollup ${name}`)
    const isErc20 = variant.feeToken === 'erc20'
    const l2ChainId = 412346 + i
    const params = {
      config: {
        confirmPeriodBlocks: 1,
        stakeToken: stakeToken.address,
        baseStake: 8,
        wasmModuleRoot: ethers.utils.id('contract-registry test chain'),
        owner: roles.owner,
        loserStakeEscrow: roles.loserStakeEscrow,
        chainId: l2ChainId,
        chainConfig: JSON.stringify(l2ChainConfig(l2ChainId, roles.owner)),
        minimumAssertionPeriod: 1,
        validatorAfkBlocks: 201600,
        miniStakeValues: [4, 2, 1],
        sequencerInboxMaxTimeVariation: {
          delayBlocks: 5760,
          futureBlocks: 12,
          delaySeconds: 86400,
          futureSeconds: 3600,
        },
        layerZeroBlockEdgeHeight: 2 ** 26,
        layerZeroBigStepEdgeHeight: 2 ** 19,
        layerZeroSmallStepEdgeHeight: 2 ** 23,
        genesisAssertionState: {
          globalState: {
            bytes32Vals: [ethers.constants.HashZero, ethers.constants.HashZero],
            u64Vals: [0, 0],
          },
          machineStatus: 1, // FINISHED
          endHistoryRoot: ethers.constants.HashZero,
        },
        genesisInboxCount: 0,
        anyTrustFastConfirmer: roles.anyTrustFastConfirmer,
        numBigStepLevel: 1,
        challengeGracePeriodBlocks: 10,
        // BridgeCreator picks the delay-bufferable SequencerInbox template iff threshold != 0.
        bufferConfig: variant.delayBufferable
          ? { threshold: 600, max: 14400, replenishRateInBasis: 500 }
          : { threshold: 0, max: 0, replenishRateInBasis: 0 },
        dataCostEstimate: 0,
      },
      validators: [validatorWallet, roles.validatorEoa],
      maxDataSize: MAX_DATA_SIZE,
      nativeToken: isErc20 ? feeToken.address : ethers.constants.AddressZero,
      deployFactoriesToL2: true,
      maxFeePerGasForRetryables: MAX_FEE_PER_GAS_FOR_RETRYABLES,
      batchPosters: [roles.batchPoster],
      batchPosterManager: roles.batchPosterManager,
      feeTokenPricer: isErc20 ? feeTokenPricer : ethers.constants.AddressZero,
      customOsp,
    }

    const optional: Record<string, string> = {}
    checkParams(createRollup.inputs[0], params, zeroByDesign(variant.feeToken), optional)
    optional.customDAValidator = customDAValidator

    const receipt = await (
      await creator.createRollup(params, { value: isErc20 ? 0 : ETH_FACTORY_DEPLOY_VALUE })
    ).wait()
    const event = receipt.events?.find(
      e => e.event === 'RollupCreated' && e.address.toLowerCase() === creator.address.toLowerCase()
    )
    if (!event) throw new Error(`${name}: no RollupCreated event`)

    // Every address in the event except nativeToken (a param, reported under optional).
    // rollupAddress / inboxAddress are reported as rollup / inbox.
    const contracts: Record<string, string> = {}
    for (const input of creator.interface.getEvent('RollupCreated').inputs) {
      if (input.type !== 'address' || input.name === 'nativeToken') continue
      contracts[input.name.replace(/Address$/, '')] = event.args[input.name]
    }

    // The variant must really differ: check the flags the templates were built with.
    const sequencerInbox = await ethers.getContractAt(
      'SequencerInbox',
      contracts.sequencerInbox,
      deployer
    )
    const usingFeeToken = await sequencerInbox.isUsingFeeToken()
    const bufferable = await sequencerInbox.isDelayBufferable()
    if (usingFeeToken !== isErc20 || bufferable !== variant.delayBufferable) {
      throw new Error(
        `${name}: SequencerInbox has isUsingFeeToken=${usingFeeToken} isDelayBufferable=${bufferable}`
      )
    }

    chains.push({ name, variant, blockNumber: receipt.blockNumber, contracts, optional })
  }

  const result = { chainId, creator: creator.address, templates, chains }
  await fs.writeFile(OUT, JSON.stringify(result, null, 2) + '\n', 'utf8')
  console.log(`Wrote ${OUT}`)
}

// Walks the ABI of the createRollup param tuple alongside `value`. Fails on a param missing from
// `value` or not in the ABI, on an empty address array, and on a zero address not in `allowZero`.
// Collects every non-zero address into `out`, keyed by param name (arrays as name[i]).
function checkParams(param, value, allowZero: Set<string>, out: Record<string, string>, path = '') {
  const where = path || param.name
  if (value === undefined || value === null) throw new Error(`createRollup param ${where} not set`)
  if (param.baseType === 'tuple') {
    const names = param.components.map(c => c.name)
    const extra = Object.keys(value).filter(k => !names.includes(k))
    if (extra.length) throw new Error(`createRollup has no param(s) ${extra.join(', ')} in ${where}`)
    for (const c of param.components) {
      checkParams(c, value[c.name], allowZero, out, path ? `${path}.${c.name}` : c.name)
    }
  } else if (param.baseType === 'array') {
    if (!Array.isArray(value)) throw new Error(`createRollup param ${where} must be an array`)
    if (param.arrayChildren.type === 'address' && value.length === 0) {
      throw new Error(`createRollup address list ${where} is empty`)
    }
    value.forEach((v, i) => checkParams(param.arrayChildren, v, allowZero, out, `${path}[${i}]`))
  } else if (param.type === 'address') {
    const leaf = where.split('.').pop()
    const name = leaf.replace(/\[\d+\]$/, '')
    if (ethers.BigNumber.from(value).isZero()) {
      if (!allowZero.has(name)) throw new Error(`createRollup address param ${where} is zero`)
      return
    }
    if (out[leaf]) throw new Error(`duplicate address param name ${leaf}`)
    out[leaf] = value
  }
}

async function deployFromArtifact(signer, name: string, args: unknown[]) {
  const factory = (await ethers.getContractFactory(name)).connect(signer)
  const contract = await factory.deploy(...args)
  await contract.deployed()
  console.log(`* ${name} created at address: ${contract.address}`)
  return contract
}

// Deploys `runtime` (hex, no 0x) with a fixed 11-byte constructor that returns it.
async function deployRaw(signer, runtime: string): Promise<string> {
  const len = runtime.length / 2
  if (len > 0xff) throw new Error('stub too long')
  const initCode = `0x60${len.toString(16).padStart(2, '0')}80600b6000396000f3${runtime}`
  const receipt = await (await signer.sendTransaction({ data: initCode })).wait()
  console.log(`* stub created at address: ${receipt.contractAddress}`)
  return receipt.contractAddress
}

async function createValidatorWallet(signer, validatorWalletCreator: string): Promise<string> {
  const creator = await ethers.getContractAt('ValidatorWalletCreator', validatorWalletCreator, signer)
  const receipt = await (await creator.createWallet([])).wait()
  const event = receipt.events?.find(e => e.event === 'WalletCreated')
  if (!event) throw new Error('no WalletCreated event')
  console.log(`* ValidatorWallet created at address: ${event.args.walletAddress}`)
  return event.args.walletAddress
}

// An L2 chain config of the shape nitro-testnode uses; its contents aren't checked on the parent chain.
function l2ChainConfig(chainId: number, owner: string) {
  return {
    chainId,
    homesteadBlock: 0,
    daoForkSupport: true,
    eip150Block: 0,
    eip150Hash: ethers.constants.HashZero,
    eip155Block: 0,
    eip158Block: 0,
    byzantiumBlock: 0,
    constantinopleBlock: 0,
    petersburgBlock: 0,
    istanbulBlock: 0,
    muirGlacierBlock: 0,
    berlinBlock: 0,
    londonBlock: 0,
    clique: { period: 0, epoch: 0 },
    arbitrum: {
      EnableArbOS: true,
      AllowDebugPrecompiles: true,
      DataAvailabilityCommittee: false,
      InitialArbOSVersion: 40,
      InitialChainOwner: owner,
      GenesisBlockNum: 0,
    },
  }
}

function mustEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} not set`)
  return value
}

main()
  .then(() => process.exit(0))
  .catch(async (error: Error) => {
    // The stack (message and frames), not console.error(error): ethers errors also carry the whole
    // transaction as properties, which inspect prints as hundreds of KB. The driver reports the
    // error file first, as its output tail keeps only the last lines.
    const text = String(error?.stack ?? error)
    const errorFile = process.env.REGISTRY_TESTCHAIN_ERROR
    if (errorFile) await fs.writeFile(errorFile, text, 'utf8').catch(() => {})
    // process.exit() can drop output still buffered for a pipe, so exit once stderr has it.
    process.stderr.write(`${text}\n`, () => process.exit(1))
  })
