/**
 * 测试用解码器：
 * - 每个解码创建一个「挂起」任务，由测试手动控制完成顺序（乱序完成）；
 * - 记录并发生成峰值，用于验证最多 4 并发；
 * - 位图关闭可计数，验证迟到结果 / LRU 淘汰确实释放了位图。
 */
import type { TileDecoder, TileRequest } from '../src/core/decoder'
import type { DecodedBitmap } from '../src/core/lru'

export class FakeBitmap implements DecodedBitmap {
  closed = false
  closeCount = 0
  source = undefined
  constructor(
    readonly key: string,
    readonly width: number,
    readonly height: number,
    readonly byteLength: number
  ) {}
  close(): void {
    this.closeCount += 1
    this.closed = true
  }
}

interface Pending {
  key: string
  request: TileRequest
  resolve: (b: DecodedBitmap) => void
  reject: (err: unknown) => void
}

export class DelayableDecoder implements TileDecoder {
  pending: Pending[] = []
  active = 0
  maxActiveSeen = 0
  started: string[] = []

  decode(request: TileRequest): Promise<DecodedBitmap> {
    return new Promise<DecodedBitmap>((resolve, reject) => {
      this.active += 1
      this.maxActiveSeen = Math.max(this.maxActiveSeen, this.active)
      this.started.push(request.key)
      this.pending.push({ key: request.key, request, resolve, reject })
    })
  }

  /** 按 key 完成指定任务（可乱序）。 */
  resolveKey(key: string, bitmap?: DecodedBitmap): void {
    const idx = this.pending.findIndex((p) => p.key === key)
    if (idx < 0) throw new Error(`没有挂起的解码任务：${key}`)
    const [p] = this.pending.splice(idx, 1)
    this.active -= 1
    p.resolve(
      bitmap ??
        new FakeBitmap(
          key,
          p.request.expectedWidth,
          p.request.expectedHeight,
          p.request.expectedWidth * p.request.expectedHeight * 4
        )
    )
  }

  failKey(key: string, message = '解码失败（测试）'): void {
    const idx = this.pending.findIndex((p) => p.key === key)
    if (idx < 0) throw new Error(`没有挂起的解码任务：${key}`)
    const [p] = this.pending.splice(idx, 1)
    this.active -= 1
    p.reject(new Error(message))
  }

  /** 按启动顺序完成第一个挂起任务。 */
  resolveFirst(bitmap?: DecodedBitmap): void {
    const p = this.pending[0]
    if (!p) throw new Error('没有挂起的解码任务')
    this.resolveKey(p.key, bitmap)
  }

  /** 等待微任务冲刷（promise 链推进）。 */
  flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** Node 18+ 提供全局 File；如缺失则给出最小桩。 */
export function makeFile(name: string, bytes = 1): File {
  if (typeof File !== 'undefined') {
    return new File([new Uint8Array(bytes)], name, { type: 'image/png' })
  }
  return { name } as unknown as File
}

/** 构造带 webkitRelativePath 的 File，模拟「选择目录」递归导入。 */
export function makeDirFile(relativePath: string, bytes = 1): File {
  const name = relativePath.split('/').pop() ?? relativePath
  const f = makeFile(name, bytes)
  Object.defineProperty(f, 'webkitRelativePath', { value: relativePath, configurable: true })
  return f
}

export function makeTileRequest(key: string, w = 256, h = 256, file?: File): TileRequest {
  return {
    key,
    file: file ?? makeFile(`${key.replace(/:/g, '_')}.png`),
    expectedWidth: w,
    expectedHeight: h
  }
}
