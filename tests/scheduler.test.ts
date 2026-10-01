import { describe, expect, it } from 'vitest'
import { TileScheduler } from '../src/core/scheduler'
import { estimateBitmapBytes } from '../src/core/lru'
import { DelayableDecoder, FakeBitmap, makeTileRequest } from './helpers'

function reqs(keys: string[], w = 256, h = 256) {
  return keys.map((k) => makeTileRequest(k, w, h))
}

describe('解码调度器：并发上限 4', () => {
  it('同时最多运行 4 个解码，按 FIFO 顺序启动', async () => {
    const decoder = new DelayableDecoder()
    const sch = new TileScheduler({ decoder, maxConcurrency: 4 })
    sch.setVisible(1, reqs(['0:0:0', '0:0:1', '0:1:0', '0:1:1', '1:0:0', '1:0:1']))

    expect(decoder.started).toEqual(['0:0:0', '0:0:1', '0:1:0', '0:1:1'])
    expect(sch.stats.inflight).toBe(4)
    expect(sch.stats.queued).toBe(2)
    expect(decoder.maxActiveSeen).toBe(4)

    decoder.resolveKey('0:0:0')
    await decoder.flush()
    expect(decoder.started[4]).toBe('1:0:0')
    expect(sch.stats.inflight).toBe(4)

    decoder.resolveKey('0:0:1')
    await decoder.flush()
    expect(decoder.started[5]).toBe('1:0:1')
  })

  it('乱序完成不影响最终可见瓦片全部就绪', async () => {
    const decoder = new DelayableDecoder()
    const sch = new TileScheduler({ decoder, maxConcurrency: 4 })
    sch.setVisible(1, reqs(['a', 'b', 'c', 'd']))
    // 故意反向完成
    decoder.resolveKey('d')
    decoder.resolveKey('b')
    decoder.resolveKey('a')
    decoder.resolveKey('c')
    await sch.whenIdle()
    for (const k of ['a', 'b', 'c', 'd']) {
      expect(sch.getBitmap(k)).toBeTruthy()
    }
    expect(sch.isIdle).toBe(true)
  })
})

describe('解码调度器：世代与迟到结果', () => {
  it('快速缩放后旧层迟到解码不得写入缓存/覆盖画面，位图被释放', async () => {
    const decoder = new DelayableDecoder()
    const sch = new TileScheduler({ decoder, maxConcurrency: 4 })

    // 第一代：level 2 概览层（缩小）
    sch.setVisible(1, reqs(['2:0:0']))
    // 立刻放大：第二代只看 level 0，旧瓦片不再可见
    sch.setVisible(2, reqs(['0:0:0', '0:0:1']))
    expect(decoder.started).toEqual(['2:0:0', '0:0:0', '0:0:1'])

    // 旧层 2:0:0 此时才迟到完成
    const staleBitmap = new FakeBitmap('2:0:0', 256, 256, estimateBitmapBytes(256, 256))
    decoder.resolveKey('2:0:0', staleBitmap)
    await decoder.flush()

    expect(staleBitmap.closed).toBe(true)
    expect(sch.getBitmap('2:0:0')).toBeUndefined()

    // 新层完成后正常可见
    decoder.resolveKey('0:0:0')
    decoder.resolveKey('0:0:1')
    await sch.whenIdle()
    expect(sch.getBitmap('0:0:0')).toBeTruthy()
    expect(sch.getBitmap('0:0:1')).toBeTruthy()
  })

  it('旧世代在途瓦片若在新视口仍可见，则提升世代并安全保留', async () => {
    const decoder = new DelayableDecoder()
    const sch = new TileScheduler({ decoder, maxConcurrency: 4 })
    sch.setVisible(1, reqs(['0:0:0', '0:0:1']))
    // 视口微调（新世代），0:0:0 仍可见，0:0:1 不可见，新增 0:0:2
    sch.setVisible(2, reqs(['0:0:0', '0:0:2']))
    expect(sch.stats.inflight + sch.stats.queued).toBeGreaterThanOrEqual(2)

    // 0:0:1 迟到且已不可见 => 丢弃
    const dropped = new FakeBitmap('0:0:1', 256, 256, estimateBitmapBytes(256, 256))
    decoder.resolveKey('0:0:1', dropped)
    await decoder.flush()
    expect(dropped.closed).toBe(true)

    // 0:0:0 虽从 gen1 启动，但仍可见 => 保留
    decoder.resolveKey('0:0:0')
    decoder.resolveKey('0:0:2')
    await sch.whenIdle()
    expect(sch.getBitmap('0:0:0')).toBeTruthy()
  })

  it('过期世代号（回退）的 setVisible 被忽略', () => {
    const decoder = new DelayableDecoder()
    const sch = new TileScheduler({ decoder })
    sch.setVisible(5, reqs(['x']))
    sch.setVisible(3, reqs(['y']))
    expect(decoder.started).toEqual(['x'])
    expect(sch.isVisibleNow('y')).toBe(false)
  })
})

describe('解码调度器：缓存淘汰联动', () => {
  it('可见瓦片被新解码挤出缓存后自动重新入队（占位→重新解码）', async () => {
    const decoder = new DelayableDecoder()
    // 容量只够 2 块
    const sch = new TileScheduler({
      decoder,
      maxConcurrency: 4,
      cacheMaxBytes: estimateBitmapBytes(256, 256) * 2 + 1
    })
    sch.setVisible(1, reqs(['a', 'b']))
    decoder.resolveKey('a')
    decoder.resolveKey('b')
    await sch.whenIdle()
    expect(sch.getBitmap('a')).toBeTruthy()

    // 新视口 c、d：淘汰 a、b（都已不可见）
    sch.setVisible(2, reqs(['c', 'd']))
    decoder.resolveKey('c')
    await decoder.flush()
    decoder.resolveKey('d')
    await sch.whenIdle()
    expect(sch.getBitmap('a')).toBeUndefined()

    // 再回到包含 a 的视口：应重新排队解码
    sch.setVisible(3, reqs(['a']))
    expect(sch.stats.queued + sch.stats.inflight).toBe(1)
    decoder.resolveFirst()
    await sch.whenIdle()
    expect(sch.getBitmap('a')).toBeTruthy()
  })

  it('极端情况下当前可见条目被淘汰，立即补位重新解码', async () => {
    const decoder = new DelayableDecoder()
    const sch = new TileScheduler({
      decoder,
      maxConcurrency: 4,
      cacheMaxBytes: estimateBitmapBytes(256, 256) * 1 + 1
    })
    // a、b 同时可见
    sch.setVisible(1, reqs(['a', 'b']))
    decoder.resolveKey('a')
    await decoder.flush()
    expect(sch.getBitmap('a')).toBeTruthy()
    // b 完成时把 a 挤出，但 a 仍可见 => 自动重新入队
    decoder.resolveKey('b')
    await decoder.flush()
    await new Promise((r) => setTimeout(r, 0))
    expect(sch.stats.queued + sch.stats.inflight).toBeGreaterThanOrEqual(1)
    // 最终 a 会被重新解码
    while (!sch.getBitmap('a')) {
      if (decoder.pending.length > 0) decoder.resolveFirst()
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(sch.getBitmap('a')).toBeTruthy()
  })
})

describe('解码调度器：失败与释放', () => {
  it('解码失败的可见瓦片标记错误，不影响其他瓦片', async () => {
    const decoder = new DelayableDecoder()
    const sch = new TileScheduler({ decoder })
    sch.setVisible(1, reqs(['ok', 'bad']))
    decoder.failKey('bad')
    decoder.resolveKey('ok')
    await sch.whenIdle()
    expect(sch.hasError('bad')).toBe(true)
    expect(sch.getBitmap('ok')).toBeTruthy()
  })

  it('dispose 清空缓存并关闭全部位图', async () => {
    const decoder = new DelayableDecoder()
    const sch = new TileScheduler({ decoder, cacheMaxBytes: 1024 * 1024 })
    sch.setVisible(1, reqs(['a']))
    decoder.resolveKey('a')
    await sch.whenIdle()
    const bm = sch.getBitmap('a') as FakeBitmap
    sch.dispose()
    expect(bm.closed).toBe(true)
    expect(sch.stats.cached).toBe(0)
  })
})
