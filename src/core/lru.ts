/**
 * 已解码位图 LRU 缓存：
 * - 以字节数为容量上限（默认约 128 MiB，按位图宽×高×4 估算）；
 * - get / 已存在的 put 刷新最近使用顺序（Map 插入序）；
 * - 淘汰与清空时调用位图的 close() 释放底层资源（ImageBitmap.close 等）；
 * - 超过整池容量的单个条目不缓存（调用方负责立即关闭或即时绘制）。
 */

export interface DecodedBitmap {
  width: number
  height: number
  /** 估算字节数（RGBA8：width * height * 4）。 */
  byteLength: number
  /** 底层可绘制对象（浏览器中为 ImageBitmap）；纯逻辑测试可缺省。 */
  source?: CanvasImageSource
  /** 释放底层位图资源。允许重复调用。 */
  close(): void
}

export interface CacheEntry<V extends DecodedBitmap> {
  key: string
  value: V
}

export class LruCache<V extends DecodedBitmap> {
  private readonly map = new Map<string, V>()
  private usedBytes = 0
  readonly maxBytes: number

  constructor(maxBytes: number) {
    if (!(maxBytes > 0)) throw new Error('LruCache maxBytes 必须为正数')
    this.maxBytes = maxBytes
  }

  get size(): number {
    return this.map.size
  }

  get bytes(): number {
    return this.usedBytes
  }

  get freeBytes(): number {
    return this.maxBytes - this.usedBytes
  }

  has(key: string): boolean {
    return this.map.has(key)
  }

  /** 读取并刷新为最近使用。 */
  get(key: string): V | undefined {
    const v = this.map.get(key)
    if (v === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, v)
    return v
  }

  /**
   * 放入条目。
   * @returns 状态：'stored' 已缓存；'exists' 键已存在（刷新）；'too_large' 超容量拒绝。
   * 淘汰通过 onEvict 回调逐个上报（value 同时会被 close）。
   */
  put(
    key: string,
    value: V,
    onEvict?: (evicted: CacheEntry<V>) => void
  ): 'stored' | 'exists' | 'too_large' {
    const existing = this.map.get(key)
    if (existing) {
      if (existing !== value) {
        this.usedBytes -= existing.byteLength
        existing.close()
        this.map.set(key, value)
        this.usedBytes += value.byteLength
        this.evict(onEvict)
      } else {
        this.map.delete(key)
        this.map.set(key, value)
      }
      return 'exists'
    }

    if (value.byteLength > this.maxBytes) {
      return 'too_large'
    }

    this.map.set(key, value)
    this.usedBytes += value.byteLength
    this.evict(onEvict)
    return 'stored'
  }

  private evict(onEvict?: (evicted: CacheEntry<V>) => void): void {
    // Map 迭代顺序为插入序：最久未使用在最前。
    for (const [key, value] of this.map) {
      if (this.usedBytes <= this.maxBytes) break
      this.map.delete(key)
      this.usedBytes -= value.byteLength
      value.close()
      onEvict?.({ key, value })
    }
  }

  /** 手动淘汰（当前不可见且需要腾空间时由调度器调用）。 */
  delete(key: string): boolean {
    const v = this.map.get(key)
    if (!v) return false
    this.map.delete(key)
    this.usedBytes -= v.byteLength
    v.close()
    return true
  }

  clear(): void {
    for (const v of this.map.values()) v.close()
    this.map.clear()
    this.usedBytes = 0
  }
}

export function estimateBitmapBytes(width: number, height: number, bytesPerPixel = 4): number {
  return Math.max(1, Math.round(width * height * bytesPerPixel))
}
