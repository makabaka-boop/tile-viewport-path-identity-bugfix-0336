/**
 * 瓦片解码调度器。
 *
 * 关键设计：
 * - 并发：最多同时运行 maxConcurrency（=4）个解码；FIFO 队列，保证顺序可测试。
 * - 世代（generation）：每次视口变化调用 setVisible(generation, requests)。
 *   快速缩放产生的旧解码若在完成时已不属于当前世代且当前也不可见，
 *   其位图立即 close() 丢弃，绝不写入缓存 / 覆盖当前画面。
 * - 缓存：LRU + 字节上限；被淘汰位图由缓存负责 close()，并通过回调通知
 *   工作台重新渲染（可见槽位会自动回到 loading/占位并重新入队）。
 */
import type { TileDecoder, TileRequest } from './decoder'
import { LruCache, type DecodedBitmap } from './lru'

export interface SchedulerOptions {
  decoder: TileDecoder
  cacheMaxBytes?: number
  maxConcurrency?: number
  /** 任一条目状态变化（完成 / 失败 / 淘汰）时回调，触发工作台渲染。 */
  onChange?: () => void
  /** 解码失败回调（用于 UI 状态提示）。 */
  onError?: (key: string, error: unknown) => void
}

export interface SchedulerStats {
  queued: number
  inflight: number
  cached: number
  cacheBytes: number
  errors: number
}

interface Job {
  key: string
  generation: number
  request: TileRequest
}

export class TileScheduler {
  readonly cache: LruCache<DecodedBitmap>
  private readonly decoder: TileDecoder
  private readonly maxConcurrency: number
  private readonly onChange?: () => void
  private readonly onError?: (key: string, error: unknown) => void

  private generation = 0
  private currentVisible = new Set<string>()
  /** 每个 key 最新一次请求对应的世代。 */
  private keyGeneration = new Map<string, number>()
  /** 每个 key 最近一次请求参数（淘汰后重新入队用）。 */
  private requests = new Map<string, TileRequest>()
  private queue: Job[] = []
  private inflight = new Map<string, Job>()
  private pumping = false
  private disposed = false
  private errorKeys = new Set<string>()
  private idleResolvers: Array<() => void> = []

  constructor(opts: SchedulerOptions) {
    this.decoder = opts.decoder
    this.maxConcurrency = opts.maxConcurrency ?? 4
    this.onChange = opts.onChange
    this.onError = opts.onError
    this.cache = new LruCache<DecodedBitmap>(opts.cacheMaxBytes ?? 128 * 1024 * 1024)
  }

  get stats(): SchedulerStats {
    return {
      queued: this.queue.length,
      inflight: this.inflight.size,
      cached: this.cache.size,
      cacheBytes: this.cache.bytes,
      errors: this.errorKeys.size
    }
  }

  get isIdle(): boolean {
    return this.queue.length === 0 && this.inflight.size === 0
  }

  /** 测试辅助：等待队列与在途任务全部结束（在每次状态变化后结算）。 */
  whenIdle(): Promise<void> {
    if (this.isIdle) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve)
    })
  }

  /**
   * 更新当前视口需要的瓦片。世代单调递增；requests 为行优先稳定顺序。
   * 已缓存 / 在途 / 已排队的瓦片不会重复解码。
   */
  setVisible(generation: number, requests: TileRequest[]): void {
    if (generation < this.generation) return
    this.generation = generation

    const next = new Set<string>()
    const toEnqueue: Job[] = []
    for (const request of requests) {
      next.add(request.key)
      this.requests.set(request.key, request)
      if (this.cache.has(request.key)) continue
      if (this.inflight.has(request.key)) {
        // 同一瓦片在新世代仍可见：把在途任务提升到新世代。
        const job = this.inflight.get(request.key)!
        job.generation = generation
        this.keyGeneration.set(request.key, generation)
        continue
      }
      if (this.queue.some((j) => j.key === request.key)) {
        const queued = this.queue.find((j) => j.key === request.key)!
        queued.generation = generation
        this.keyGeneration.set(request.key, generation)
        continue
      }
      this.errorKeys.delete(request.key)
      this.keyGeneration.set(request.key, generation)
      toEnqueue.push({ key: request.key, generation, request })
    }
    this.currentVisible = next

    // 清理已不可见且无在途/排队任务的陈旧元数据，避免长期持有 File 对象。
    for (const key of this.keyGeneration.keys()) {
      if (next.has(key) || this.inflight.has(key) || this.queue.some((j) => j.key === key)) {
        continue
      }
      this.keyGeneration.delete(key)
      this.requests.delete(key)
      this.errorKeys.delete(key)
    }

    this.queue.push(...toEnqueue)
    this.pump()
  }

  /** 当前世代仍可见的 key（供测试与状态判断）。 */
  isVisibleNow(key: string): boolean {
    return this.currentVisible.has(key)
  }

  getBitmap(key: string): DecodedBitmap | undefined {
    return this.cache.get(key)
  }

  /** 某瓦片是否解码失败（当前世代）。 */
  hasError(key: string): boolean {
    return this.errorKeys.has(key)
  }

  /** 可见瓦片被淘汰后重新入队；已排队 / 在途 / 已缓存时跳过。 */
  private reenqueueIfVisible(key: string): void {
    if (this.disposed || !this.currentVisible.has(key)) return
    if (this.cache.has(key) || this.inflight.has(key)) return
    if (this.queue.some((j) => j.key === key)) return
    const request = this.requests.get(key)
    if (!request) return
    const generation = this.keyGeneration.get(key) ?? this.generation
    this.queue.push({ key, generation, request })
  }

  private pump(): void {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.inflight.size < this.maxConcurrency && this.queue.length > 0) {
        const job = this.queue.shift()!
        this.inflight.set(job.key, job)
        void this.runJob(job)
      }
    } finally {
      this.pumping = false
    }
    this.checkIdle()
  }

  private async runJob(job: Job): Promise<void> {
    if (this.disposed) return
    let bitmap: DecodedBitmap | null = null
    try {
      bitmap = await this.decoder.decode(job.request)
    } catch (err) {
      this.inflight.delete(job.key)
      if (this.disposed) {
        this.checkIdle()
        return
      }
      // 仅当仍属于当前可见集合时报告错误占位。
      if (this.isVisibleNow(job.key)) {
        this.errorKeys.add(job.key)
        this.onError?.(job.key, err)
        this.onChange?.()
      }
      this.pump()
      return
    }

    if (this.disposed) {
      this.inflight.delete(job.key)
      bitmap.close()
      this.checkIdle()
      return
    }

    this.inflight.delete(job.key)

    // 迟到结果判定（核心不变式）：解码是异步的，完成时该瓦片必须仍属于当前
    // 视口可见集合，否则一律释放位图、绝不写入缓存——因此快速缩放后的旧层
    // 迟到解码不可能覆盖当前画面，也不会污染缓存。当前层级瓦片的 key（含 level）
    // 一定在可见集合中；世代号回退的 setVisible 在入口处已被忽略。
    if (!this.currentVisible.has(job.key)) {
      bitmap.close()
      this.pump()
      return
    }

    // 当前可见（即使该任务在较早世代启动、缩放后该瓦片仍可见）：安全进入缓存。
    const result = this.cache.put(job.key, bitmap, (evicted) => {
      // 条目被 LRU 淘汰：缓存已 close()。若它当前仍可见，立即重新入队补回，
      // 渲染期间工作台会先看到缺失而显示占位。
      this.reenqueueIfVisible(evicted.key)
      // 淘汰统一通知工作台渲染。
      this.onChange?.()
    })
    if (result === 'too_large') {
      bitmap.close()
      if (this.currentVisible.has(job.key)) {
        this.errorKeys.add(job.key)
        this.onError?.(job.key, new Error('瓦片位图超过缓存容量'))
      }
    }
    this.onChange?.()
    this.pump()
  }

  private checkIdle(): void {
    if (!this.isIdle || this.idleResolvers.length === 0) return
    const resolvers = this.idleResolvers
    this.idleResolvers = []
    // 异步结算，确保最后一批 onChange 已被消费。
    resolvers.forEach((resolve) => resolve())
  }

  /** 释放全部位图并清空队列（切换 / 关闭工作台时调用）。 */
  dispose(): void {
    this.disposed = true
    this.queue = []
    this.inflight.clear()
    this.currentVisible.clear()
    this.keyGeneration.clear()
    this.requests.clear()
    this.errorKeys.clear()
    this.cache.clear()
    // 在途解码完成后会因 disposed 标记自行关闭，无法强杀原生解码。
    this.checkIdle()
  }
}
