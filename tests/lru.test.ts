import { describe, expect, it } from 'vitest'
import { LruCache, estimateBitmapBytes } from '../src/core/lru'
import { FakeBitmap } from './helpers'

function tileBitmap(key: string, size = 256): FakeBitmap {
  return new FakeBitmap(key, size, size, estimateBitmapBytes(size, size))
}

describe('LRU 缓存：内存上限与释放', () => {
  it('按字节计数，超容量时淘汰最久未使用条目并 close', () => {
    // 每块 256*256*4 = 262144 字节；容量只够 2 块。
    const cache = new LruCache<FakeBitmap>(estimateBitmapBytes(256, 256) * 2 + 1)
    const a = tileBitmap('a')
    const b = tileBitmap('b')
    const c = tileBitmap('c')

    expect(cache.put('a', a)).toBe('stored')
    expect(cache.put('b', b)).toBe('stored')

    const evictedKeys: string[] = []
    cache.put('c', c, (e) => evictedKeys.push(e.key))

    expect(evictedKeys).toEqual(['a'])
    expect(a.closed).toBe(true)
    expect(b.closed).toBe(false)
    expect(c.closed).toBe(false)
    expect(cache.has('a')).toBe(false)
    expect(cache.has('b')).toBe(true)
    expect(cache.has('c')).toBe(true)
  })

  it('get 刷新最近使用顺序，被访问者最后淘汰', () => {
    const cache = new LruCache<FakeBitmap>(estimateBitmapBytes(256, 256) * 2 + 1)
    const a = tileBitmap('a')
    const b = tileBitmap('b')
    const c = tileBitmap('c')
    cache.put('a', a)
    cache.put('b', b)
    expect(cache.get('a')).toBe(a) // a 变最新，b 变最旧

    const evictedKeys: string[] = []
    cache.put('c', c, (e) => evictedKeys.push(e.key))
    expect(evictedKeys).toEqual(['b'])
    expect(b.closed).toBe(true)
    expect(cache.get('a')).toBe(a)
    expect(cache.get('c')).toBe(c)
  })

  it('同键覆盖关闭旧值', () => {
    const cache = new LruCache<FakeBitmap>(1024 * 1024)
    const a1 = tileBitmap('a')
    const a2 = tileBitmap('a')
    cache.put('a', a1)
    cache.put('a', a2)
    expect(a1.closed).toBe(true)
    expect(a2.closed).toBe(false)
    expect(cache.get('a')).toBe(a2)
  })

  it('超过整池容量的单一条目拒绝缓存', () => {
    const cache = new LruCache<FakeBitmap>(1024)
    const big = new FakeBitmap('big', 256, 256, 4096)
    expect(cache.put('big', big)).toBe('too_large')
    expect(cache.has('big')).toBe(false)
    // 拒绝时缓存不负责关闭（调用方即时绘制后自行关闭），这里仅验证未被缓存
    expect(cache.size).toBe(0)
  })

  it('clear 释放全部位图', () => {
    const cache = new LruCache<FakeBitmap>(1024 * 1024)
    const a = tileBitmap('a')
    const b = tileBitmap('b')
    cache.put('a', a)
    cache.put('b', b)
    cache.clear()
    expect(a.closed).toBe(true)
    expect(b.closed).toBe(true)
    expect(cache.size).toBe(0)
    expect(cache.bytes).toBe(0)
  })

  it('delete 释放指定条目', () => {
    const cache = new LruCache<FakeBitmap>(1024 * 1024)
    const a = tileBitmap('a')
    cache.put('a', a)
    expect(cache.delete('a')).toBe(true)
    expect(a.closed).toBe(true)
    expect(cache.delete('a')).toBe(false)
  })

  it('淘汰链：容量只够 1 块时连续放入，旧值依次关闭', () => {
    const cache = new LruCache<FakeBitmap>(estimateBitmapBytes(256, 256) + 1)
    const bitmaps = ['a', 'b', 'c', 'd'].map((k) => tileBitmap(k))
    const evicted: string[] = []
    for (const bm of bitmaps) {
      cache.put(bm.key, bm, (e) => evicted.push(e.key))
    }
    expect(evicted).toEqual(['a', 'b', 'c'])
    expect(bitmaps.slice(0, 3).every((b) => b.closed)).toBe(true)
    expect(bitmaps[3].closed).toBe(false)
  })
})
