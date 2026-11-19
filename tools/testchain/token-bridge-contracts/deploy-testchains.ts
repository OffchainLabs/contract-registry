// @ts-nocheck -- this file runs inside a token-bridge-contracts checkout (ts-node, CommonJS, ethers v5),
// which is where its imports resolve. It is not type-checked in the registry repo.
//
// Parent-chain half of the token bridge's test-chain deployer, for the publish process's
// test-chain check (spec §5.8).
//
// The driver (tools/src/testchain/token-bridge-contracts.ts) copies this file into the checkout's
// scripts/ directory and runs it with the checkout's ts-node against a local anvil node, the
// parent chain. It:
//   1. deploys the token bridge creator and its templates with the checkout's own
//      deployL1TokenBridgeCreator() (scripts/atomicTokenBridgeDeployer.ts), as the release's own
//      deployment does;
//   2. for each variant (ETH or an ERC20 fee token; and, where the creator has
//      createYbbTokenBridge, the yield-bearing bridge of each), stands up the parent side of a
//      rollup: nitro-contracts' Bridge and Inbox (or ERC20Bridge and ERC20Inbox) behind proxies,
//      the rollup's ProxyAdmin and UpgradeExecutor, and a stand-in for the rollup contract that
//      answers owner() and chainId(), the only calls the creator makes to it;
//   3. creates a token bridge for each with the creator, which deploys the parent side and sends
//      the child side as two retryable tickets;
//   4. on ETH variants, deposits a token through the router, so the child chain gets a bridged
//      token (a third retryable) and, on a yield-bearing bridge, the parent chain the token's
//      MasterVault;
//   5. writes the addresses as JSON to $REGISTRY_TESTCHAIN_OUT.
// The driver then replays every retryable on a child chain per variant. On failure this script
// writes the error's stack to $REGISTRY_TESTCHAIN_ERROR.
//
// The nitro-contracts artifacts come from a pinned npm release the driver downloads
// ($NITRO_ARTIFACTS, its build/contracts), not from the checkout, whose own version varies by tag.

import { ethers } from 'ethers'
import { promises as fs, readFileSync } from 'fs'
import * as path from 'path'
import { deployL1TokenBridgeCreator } from './atomicTokenBridgeDeployer'

const OUT = mustEnv('REGISTRY_TESTCHAIN_OUT')
const RPC_URL = mustEnv('PARENT_RPC_URL')
const DEPLOYER_KEY = mustEnv('DEPLOYER_KEY')
const NITRO = mustEnv('NITRO_ARTIFACTS')
const CHECKOUT = path.resolve(__dirname, '..')

// nitro-contracts' default for a chain on Ethereum (deployCreatorAndCreateRollup.ts).
const MAX_DATA_SIZE = 117964
// Retryable gas limits and price. The child chain is replayed with its own gas accounting, so
// these only size the fees paid on the parent chain.
const GAS_LIMIT_FOR_L2_FACTORY = 6_000_000
const MAX_GAS_FOR_CONTRACTS = 30_000_000
const DEPOSIT_MAX_GAS = 1_000_000
const GAS_PRICE_BID = ethers.utils.parseUnits('0.1', 'gwei')
const DEPOSIT_MAX_SUBMISSION_COST = ethers.utils.parseEther('0.01')
// Pays the ETH variants' retryables; the creator refunds the excess.
const CREATE_VALUE = ethers.utils.parseEther('1')
const FIRST_CHILD_CHAIN_ID = 412346

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(RPC_URL)
  // ethers' default 4s polling makes each tx.wait() take seconds on a local node.
  provider.pollingInterval = 50
  const deployer = new ethers.Wallet(DEPLOYER_KEY, provider)
  const { chainId } = await provider.getNetwork()

  // 1. The creator and its templates, as the release deploys them.
  console.log('Deploying the parent chain WETH')
  const l1Weth = await deploy(deployer, tbArtifact('contracts/tokenbridge/test/TestWETH9.sol/TestWETH9.json'), ['WETH', 'WETH'])
  console.log('Deploying L1TokenBridgeCreator')
  const { l1TokenBridgeCreator: creator, retryableSender } = await deployL1TokenBridgeCreator(
    deployer,
    l1Weth.address,
    ethers.BigNumber.from(GAS_LIMIT_FOR_L2_FACTORY)
  )
  if ((await creator.l1Templates()).routerTemplate === ethers.constants.AddressZero) {
    throw new Error('deployL1TokenBridgeCreator left the creator without templates')
  }
  const hasYbb = !!creator.interface.functions['createYbbTokenBridge(address,address,uint256,uint256)']

  const variants = [
    { name: 'eth', feeToken: 'eth', ybb: false },
    { name: 'erc20', feeToken: 'erc20', ybb: false },
    ...(hasYbb
      ? [
          { name: 'eth-ybb', feeToken: 'eth', ybb: true },
          { name: 'erc20-ybb', feeToken: 'erc20', ybb: true },
        ]
      : []),
  ]

  const out = []
  for (const [i, v] of variants.entries()) {
    const childChainId = FIRST_CHILD_CHAIN_ID + i
    console.log(`Variant ${v.name}: parent side of a rollup for chain ${childChainId}`)
    const feeToken = v.feeToken === 'erc20' ? await deploy(deployer, nitroArtifact('src/test-helpers/TestToken.sol/TestToken.json'), [ethers.utils.parseEther('1000000000')]) : null
    const rollup = await rollupParentSide(deployer, childChainId, feeToken)

    // 3. The token bridge.
    console.log(`Variant ${v.name}: creating the token bridge`)
    const create = v.ybb ? creator.createYbbTokenBridge : creator.createTokenBridge
    if (feeToken) await (await feeToken.approve(creator.address, ethers.constants.MaxUint256)).wait()
    const receipt = await (
      await create(rollup.inbox, deployer.address, MAX_GAS_FOR_CONTRACTS, GAS_PRICE_BID, { value: feeToken ? 0 : CREATE_VALUE })
    ).wait()
    const { l1, l2 } = await deployment(creator, rollup.inbox, receipt, childChainId, !!feeToken)
    if (!l1.router || !l2.router) throw new Error(`${v.name}: the creator recorded no deployment for inbox ${rollup.inbox}`)

    // 4. A deposit, so the child chain deploys a bridged token.
    const tokens = []
    if (!feeToken) tokens.push(await deposit(deployer, l1, v.ybb))

    out.push({
      name: v.name,
      feeToken: v.feeToken,
      ybb: v.ybb,
      childChainId,
      ...rollup,
      l2Factory: await creator.canonicalL2FactoryAddress(),
      l1,
      l2,
      tokens,
    })
  }

  const result = { chainId, creator: creator.address, retryableSender: retryableSender.address, variants: out }
  await fs.writeFile(OUT, JSON.stringify(result, null, 2) + '\n', 'utf8')
  console.log(`Wrote ${OUT}`)
}

// 2. What the creator needs of a rollup on the parent chain: an Inbox whose bridge() has a
// rollup() whose owner() is an UpgradeExecutor where the token bridge's owner has the executor
// role, the Inbox's proxy admin (getProxyAdmin(), which becomes the admin of the parent side's
// proxies), and the rollup's chainId(). The Bridge and Inbox are nitro-contracts', set up as the
// RollupCreator sets them up; the rollup contract itself is a stand-in.
async function rollupParentSide(deployer, childChainId: number, feeToken) {
  const proxyAdmin = await deploy(deployer, nitroArtifact('@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol/ProxyAdmin.json'), [])
  const proxy = async (logic, initData = '0x') =>
    (await deploy(deployer, nitroArtifact('@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol/TransparentUpgradeableProxy.json'), [logic.address, proxyAdmin.address, initData])).address

  // The rollup's UpgradeExecutor, as the RollupCreator makes it: its own admin, the owner an executor.
  const ueArtifact = readJson(path.join(CHECKOUT, 'node_modules/@offchainlabs/upgrade-executor/build/contracts/src/UpgradeExecutor.sol/UpgradeExecutor.json'))
  const ueLogic = await deploy(deployer, ueArtifact, [])
  const upgradeExecutor = new ethers.Contract(await proxy(ueLogic), ueArtifact.abi, deployer)
  await (await upgradeExecutor.initialize(upgradeExecutor.address, [deployer.address])).wait()
  await (await proxyAdmin.transferOwnership(upgradeExecutor.address)).wait()

  const rollup = await deployRaw(deployer, rollupStandInRuntime(upgradeExecutor.address, childChainId))

  const bridgeArtifact = nitroArtifact(feeToken ? 'src/bridge/ERC20Bridge.sol/ERC20Bridge.json' : 'src/bridge/Bridge.sol/Bridge.json')
  const bridgeIface = new ethers.utils.Interface(bridgeArtifact.abi)
  const bridge = await proxy(
    await deploy(deployer, bridgeArtifact, []),
    feeToken ? bridgeIface.encodeFunctionData('initialize', [rollup, feeToken.address]) : bridgeIface.encodeFunctionData('initialize', [rollup])
  )
  const inboxArtifact = nitroArtifact(feeToken ? 'src/bridge/ERC20Inbox.sol/ERC20Inbox.json' : 'src/bridge/Inbox.sol/Inbox.json')
  // No SequencerInbox: retryables never touch it.
  const inbox = await proxy(
    await deploy(deployer, inboxArtifact, [MAX_DATA_SIZE]),
    new ethers.utils.Interface(inboxArtifact.abi).encodeFunctionData('initialize', [bridge, ethers.constants.AddressZero])
  )
  // Bridge.setDelayedInbox is onlyRollupOrOwner: the rollup's owner, through the executor.
  await (await upgradeExecutor.executeCall(bridge, bridgeIface.encodeFunctionData('setDelayedInbox', [inbox, true]))).wait()

  return { rollup, bridge, inbox, proxyAdmin: proxyAdmin.address, upgradeExecutor: upgradeExecutor.address, ...(feeToken ? { nativeToken: feeToken.address } : {}) }
}

// Runtime code answering owner() with `owner` and chainId() with `chainId`, and reverting on
// anything else:
//   selector = calldata[0:4]
//   if selector == owner()   (0x8da5cb5b): return owner
//   if selector == chainId() (0x9a8a0592): return chainId
//   revert
function rollupStandInRuntime(owner: string, chainId: number): string {
  const word = (hex: string, bytes: number) => hex.replace(/^0x/, '').toLowerCase().padStart(bytes * 2, '0')
  const ret = '60005260206000f3' // MSTORE at 0, RETURN 32 bytes
  const ownerDest = 33
  const chainIdDest = ownerDest + 1 + 21 + 8
  return (
    '60003560e01c' + // PUSH1 0 CALLDATALOAD PUSH1 0xe0 SHR
    `80638da5cb5b1461${word(ownerDest.toString(16), 2)}57` + // DUP1 PUSH4 owner() EQ PUSH2 dest JUMPI
    `80639a8a05921461${word(chainIdDest.toString(16), 2)}57` + // DUP1 PUSH4 chainId() EQ PUSH2 dest JUMPI
    '60006000fd' + // REVERT
    `5b73${word(owner, 20)}${ret}` +
    `5b7f${word(chainId.toString(16), 32)}${ret}`
  )
}

// Deposits a new token into the standard gateway through the router, as a user would; returns
// the token, the address its bridged token gets on the child chain and, on a yield-bearing
// bridge, the token's vault, which the deposit deployed.
async function deposit(deployer, l1: Record<string, string>, ybb: boolean) {
  const token = await deploy(deployer, nitroArtifact('src/test-helpers/TestToken.sol/TestToken.json'), [ethers.utils.parseEther('1000')])
  const amount = ethers.utils.parseEther('1')
  await (await token.approve(l1.standardGateway, amount)).wait()
  const router = new ethers.Contract(
    l1.router,
    ['function outboundTransfer(address,address,uint256,uint256,uint256,bytes) payable returns (bytes)'],
    deployer
  )
  const data = ethers.utils.defaultAbiCoder.encode(['uint256', 'bytes'], [DEPOSIT_MAX_SUBMISSION_COST, '0x'])
  await (
    await router.outboundTransfer(token.address, deployer.address, amount, DEPOSIT_MAX_GAS, GAS_PRICE_BID, data, {
      value: DEPOSIT_MAX_SUBMISSION_COST.add(GAS_PRICE_BID.mul(DEPOSIT_MAX_GAS)),
    })
  ).wait()
  const gateway = new ethers.Contract(
    l1.standardGateway,
    ['function calculateL2TokenAddress(address) view returns (address)', 'function masterVaultFactory() view returns (address)'],
    deployer
  )
  const out = { l1: token.address, l2: await gateway.calculateL2TokenAddress(token.address) }
  if (!ybb) return out
  const factory = new ethers.Contract(await gateway.masterVaultFactory(), ['function calculateVaultAddress(address) view returns (address)'], deployer)
  return { ...out, vault: await factory.calculateVaultAddress(token.address) }
}

// The token bridge's addresses on both chains, keyed as in the creator's L1DeploymentAddresses
// and L2DeploymentAddresses: its inboxToL1Deployment and inboxToL2Deployment from v1.2.0 on.
// Before, the creator kept no record: the parent chain's come from its OrbitTokenBridgeCreated
// event, and the child chain's from its getCanonicalL2*(chainId), as the release's own
// createTokenBridge() script collects them.
async function deployment(creator, inbox: string, receipt, childChainId: number, feeToken: boolean) {
  if (creator.interface.functions['inboxToL1Deployment(address)']) {
    return { l1: addresses(await creator.inboxToL1Deployment(inbox)), l2: addresses(await creator.inboxToL2Deployment(inbox)) }
  }
  const created = receipt.logs
    .filter(l => l.address.toLowerCase() === creator.address.toLowerCase())
    .map(l => creator.interface.parseLog(l))
    .find(e => e.name === 'OrbitTokenBridgeCreated')
  if (!created) throw new Error(`no OrbitTokenBridgeCreated event for inbox ${inbox}`)
  const { router, standardGateway, customGateway, wethGateway } = created.args
  const l1 = addresses({ router, standardGateway, customGateway, wethGateway })
  const l2: Record<string, string> = {}
  for (const [k, getter] of Object.entries({
    router: 'getCanonicalL2RouterAddress',
    standardGateway: 'getCanonicalL2StandardGatewayAddress',
    customGateway: 'getCanonicalL2CustomGatewayAddress',
    // Predicted for every chain, deployed only on ETH chains.
    ...(feeToken ? {} : { wethGateway: 'getCanonicalL2WethGatewayAddress', weth: 'getCanonicalL2WethAddress' }),
    proxyAdmin: 'getCanonicalL2ProxyAdminAddress',
    beaconProxyFactory: 'getCanonicalL2BeaconProxyFactoryAddress',
    upgradeExecutor: 'getCanonicalL2UpgradeExecutorAddress',
    multicall: 'getCanonicalL2Multicall',
  })) {
    l2[k] = await creator[getter](childChainId)
  }
  return { l1, l2: addresses(l2) }
}

// The named address fields of a struct returned by ethers, without zeros.
function addresses(result): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(result)) {
    if (/^\d+$/.test(k) || typeof v !== 'string' || !ethers.utils.isAddress(v)) continue
    if (v !== ethers.constants.AddressZero) out[k] = v
  }
  return out
}

function tbArtifact(rel: string) {
  return readJson(path.join(CHECKOUT, 'build/contracts', rel))
}

function nitroArtifact(rel: string) {
  return readJson(path.join(NITRO, rel))
}

function readJson(file: string) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

async function deploy(signer, artifact, args: unknown[]) {
  if (/__\$[0-9a-fA-F]{34}\$__/.test(artifact.bytecode)) throw new Error(`${artifact.contractName} needs linked libraries`)
  const contract = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer).deploy(...args)
  await contract.deployed()
  console.log(`* ${artifact.contractName} created at address: ${contract.address}`)
  return contract
}

// Deploys `runtime` (hex, no 0x) with a fixed 11-byte constructor that returns it.
async function deployRaw(signer, runtime: string): Promise<string> {
  const len = runtime.length / 2
  if (len > 0xff) throw new Error('stub too long')
  const initCode = `0x60${len.toString(16).padStart(2, '0')}80600b6000396000f3${runtime}`
  const receipt = await (await signer.sendTransaction({ data: initCode })).wait()
  console.log(`* rollup stand-in created at address: ${receipt.contractAddress}`)
  return receipt.contractAddress
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
