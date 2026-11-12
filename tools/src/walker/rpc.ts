/**
 * Minimal read-only JSON-RPC client: eth_getCode, eth_getStorageAt, eth_call, pinned to one block.
 * Transport errors and rate limits are retried; execution errors (reverts) are reported as such,
 * so a flaky RPC never looks like a reverting getter.
 */
export class RpcError extends Error {
  readonly code: number | undefined
  readonly data: unknown
  constructor(message: string, code?: number, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

export class ExecutionError extends Error {}

export interface RpcOptions { concurrency?: number; retries?: number; timeoutMs?: number }

export class Rpc {
  readonly url: string
  private readonly concurrency: number
  private readonly retries: number
  private readonly timeoutMs: number
  private active = 0
  private waiting: (() => void)[] = []
  private id = 0
  requests = 0

  constructor(url: string, opts: RpcOptions = {}) {
    this.url = url
    this.concurrency = opts.concurrency ?? 8
    this.retries = opts.retries ?? 6
    this.timeoutMs = opts.timeoutMs ?? 30_000
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>(r => this.waiting.push(r))
    this.active++
    try { return await fn() } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }

  async request<T>(method: string, params: unknown[]): Promise<T> {
    return this.slot(async () => {
      let delay = 250
      for (let attempt = 0; ; attempt++) {
        this.requests++
        let body: any
        try {
          const res = await fetch(this.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
            signal: AbortSignal.timeout(this.timeoutMs),
          })
          if (res.status === 429 || res.status >= 500) throw new RpcError(`HTTP ${res.status}`, res.status)
          body = await res.json()
        } catch (e) {
          if (attempt >= this.retries) throw new RpcError(`${method} failed after ${attempt + 1} attempts: ${(e as Error).message}`)
          await sleep(delay); delay *= 2
          continue
        }
        if (body.error) {
          const msg: string = body.error.message ?? JSON.stringify(body.error)
          if (method === 'eth_call' && isExecutionFailure(body.error.code, msg)) throw new ExecutionError(msg)
          if (attempt < this.retries && isRetryable(body.error.code, msg)) { await sleep(delay); delay *= 2; continue }
          throw new RpcError(`${method}: ${msg}`, body.error.code, body.error.data)
        }
        return body.result as T
      }
    })
  }

  chainId(): Promise<number> { return this.request<string>('eth_chainId', []).then(h => Number(h)) }
  blockNumber(): Promise<bigint> { return this.request<string>('eth_blockNumber', []).then(h => BigInt(h)) }
  getCode(address: string, block: string): Promise<string> { return this.request('eth_getCode', [address, block]) }
  getStorageAt(address: string, slot: string, block: string): Promise<string> { return this.request('eth_getStorageAt', [address, slot, block]) }
  call(to: string, data: string, block: string): Promise<string> { return this.request('eth_call', [{ to, data }, block]) }
}

function isExecutionFailure(code: number | undefined, msg: string): boolean {
  return code === 3 || /revert|invalid opcode|out of gas|stack (underflow|overflow)|invalid jump|execution|bad instruction|opcode/i.test(msg)
}

function isRetryable(code: number | undefined, msg: string): boolean {
  return code === 429 || code === -32005 || code === -32603 || /rate|limit|capacity|timeout|too many|try again|header not found|busy/i.test(msg)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
