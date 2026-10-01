import { describe, expect, it } from 'vitest'
import { parseManifest } from '../src/core/manifest'
import type { ManifestJSON } from '../src/core/types'
import { TileScheduler } from '../src/core/scheduler'
import { Workbench, slotKey } from '../src/core/workbench'
import { DelayableDecoder, makeFile } from './helpers'

/** 构造 3 层金字塔：512 / 256 / 128，每层铺满 256 瓦片（边缘层允许不足）。 */
function pyramidManifest(): ManifestJSON {
  return {
    name: 'pyr',
    width: 512,
    height: 512,
    tileSize: 256,
    layers: [
      {
        level: 0,
        width: 512,
        height: 512,
        tiles: [
          { col: 0, row: 0, file: 'l0/0_0.png' },
          { col: 1, row: 0, file: 'l0/0_1.png' },
          { col: 0, row: 1, file: 'l0/1_0.png' },
          { col: 1, row: 1, file: 'l0/1_1.png' }
        ]
      },
      {
        level: 1,
        width: 256,
        height: 256,
        tiles: [{ col: 0, row: 0, file: 'l1/0_0.png' }]
      },
      {
        level: 2,
        width: 128,
        height: 128,
        tiles: [{ col: 0, row: 0, width: 128, height: 128, file: 'l2/0_0.png' }]
      }
    ]
  }
}

function setup(opts: { omitFiles?: string[] } = {}) {
  const { manifest } = parseManifest(pyramidManifest())
  if (!manifest) throw new Error('manifest 解析失败')
  const omit = new Set(opts.omitFiles ?? [])
  const byPath = new Map<string, File>()
  for (const layer of manifest.layers) {
    for (const tile of layer.tiles.values()) {
      if (!omit.has(tile.file)) byPath.set(tile.file, makeFile(tile.file.split('/').pop()!))
    }
  }
  const decoder = new DelayableDecoder()
  const scheduler = new TileScheduler({ decoder, maxConcurrency: 4 })
  const wb = new Workbench({ manifest, files: byPath, scheduler })
  wb.setViewport(800, 600)
  wb.activate()
  return { wb, scheduler, decoder, manifest }
}

async function settle(decoder: DelayableDecoder, scheduler: TileScheduler): Promise<void> {
  while (!scheduler.isIdle) {
    if (decoder.pending.length > 0) decoder.resolveFirst()
    await new Promise((r) => setTimeout(r, 0))
  }
}

describe('Workbench：视口映射与层级选择', () => {
  it('放大时切到 level 0；缩小概览时切到高层', () => {
    const { wb } = setup()
    const slots0 = wb.computeSlots()
    expect(slots0.length).toBeGreaterThan(0)

    // 放大：1 原图像素占多屏像素 => 必须使用 level 0，纹理不被放大
    wb.zoomAtPoint(400, 300, 8)
    const zoomed = wb.computeSlots()
    expect(zoomed.every((s) => s.level === 0)).toBe(true)

    // 缩小到概览：level 2（scale 0.25）纹理接近 1:1，应选用更高 level
    wb.zoomAtPoint(400, 300, 1 / 40)
    const overview = wb.computeSlots()
    expect(overview.length).toBeGreaterThan(0)
    expect(overview[0].level).toBeGreaterThan(0)
  })

  it('所有槽位屏幕矩形与相机映射一致（视口始终映射原图坐标）', () => {
    const { wb } = setup()
    wb.zoomAtPoint(150, 120, 3)
    for (const slot of wb.computeSlots()) {
      const expectedW = slot.imageW * wb.camera.scale
      const expectedH = slot.imageH * wb.camera.scale
      expect(slot.screenW).toBeCloseTo(expectedW, 6)
      expect(slot.screenH).toBeCloseTo(expectedH, 6)
    }
  })
})

describe('Workbench：缺失瓦片明确占位', () => {
  it('未选择的瓦片文件状态为 missing 而非 loading', async () => {
    const { wb, decoder, scheduler } = setup({ omitFiles: ['l0/0_0.png', 'l2/0_0.png'] })
    // 缩放到 level0 可见
    wb.zoomAtPoint(400, 300, 8)
    const missingSlot = wb
      .computeSlots()
      .find((s) => s.level === 0 && s.col === 0 && s.row === 0)!
    expect(missingSlot.state).toBe('missing')
    expect(missingSlot.file).toBe('l0/0_0.png')

    // 其余瓦片可正常解码
    await settle(decoder, scheduler)
    const readySlot = wb
      .computeSlots()
      .find((s) => s.level === 0 && s.col === 1 && s.row === 0)!
    expect(readySlot.state).toBe('ready')

    scheduler.dispose()
  })

  it('manifest 未定义的网格位置同样显示 missing', () => {
    const { wb } = setup()
    wb.zoomAtPoint(400, 300, 8)
    // 512 图恰好铺满，无空洞；构造一个有缺失网格的 manifest 来验证
    const partial = {
      name: 'p',
      width: 512,
      height: 512,
      tileSize: 256,
      layers: [
        {
          level: 0,
          width: 512,
          height: 512,
          tiles: [
            { col: 0, row: 0, file: 'a.png' },
            { col: 1, row: 1, file: 'd.png' }
          ]
        }
      ]
    }
    const parsed = parseManifest(partial)
    expect(parsed.manifest).not.toBeNull()
    const byPath = new Map<string, File>([
      ['a.png', makeFile('a.png')],
      ['d.png', makeFile('d.png')]
    ])
    const scheduler = new TileScheduler({ decoder: new DelayableDecoder() })
    const wb2 = new Workbench({ manifest: parsed.manifest!, files: byPath, scheduler })
    wb2.setViewport(800, 600)
    wb2.activate()
    const states = new Map(wb2.computeSlots().map((s) => [`${s.col}:${s.row}`, s.state]))
    expect(states.get('0:0')).toBe('loading')
    expect(states.get('1:0')).toBe('missing')
    expect(states.get('0:1')).toBe('missing')
    scheduler.dispose()
  })
})

describe('Workbench：框选导出原图坐标 JSON', () => {
  it('在已知相机下框选，导出坐标与原图坐标严格一致', () => {
    const { wb } = setup()
    // 放到已知 scale 便于手算
    wb.zoomAtPoint(400, 300, 1)
    const scale = wb.camera.scale
    wb.setTool('select')

    // 选取原图矩形 [100,120]-[360,300]，换算到屏幕后模拟拖拽
    const sx = (ix: number): number => 400 + (ix - wb.camera.centerX) * scale
    const sy = (iy: number): number => 300 + (iy - wb.camera.centerY) * scale

    wb.pointerDown(sx(100), sy(120), 0, false)
    wb.pointerMove(sx(360), sy(300))
    wb.pointerUp()

    const result = wb.exportSelection()
    expect(result).not.toBeNull()
    const parsed = JSON.parse(result!.json)
    expect(parsed.coordinateSpace).toBe('image')
    expect(parsed.image).toEqual({ width: 512, height: 512 })
    expect(parsed.selection.x).toBeCloseTo(100, 5)
    expect(parsed.selection.y).toBeCloseTo(120, 5)
    expect(parsed.selection.width).toBeCloseTo(260, 5)
    expect(parsed.selection.height).toBeCloseTo(180, 5)
  })

  it('导出包含相交的 level 0 瓦片坐标与文件名', () => {
    const { wb } = setup()
    wb.setTool('select')
    // 直接构造一个跨越 4 块 256 瓦片的选择
    wb.pointerDown(0, 0, 0, false)
    // 通过连续移动覆盖到右下（屏幕坐标足够大，会被夹到图像边缘）
    wb.pointerMove(2000, 2000)
    wb.pointerUp()
    const parsed = JSON.parse(wb.exportSelection()!.json)
    expect(parsed.level0Tiles).toHaveLength(4)
    expect(parsed.level0Tiles).toContainEqual({
      level: 0,
      col: 0,
      row: 0,
      file: 'l0/0_0.png',
      resolvedFile: '0_0.png',
      resolvedSize: expect.any(Number)
    })
    expect(parsed.level0Tiles).toContainEqual({
      level: 0,
      col: 1,
      row: 1,
      file: 'l0/1_1.png',
      resolvedFile: '1_1.png',
      resolvedSize: expect.any(Number)
    })
  })

  it('反方向拖拽仍导出正宽高且夹在图像范围内', () => {
    const { wb } = setup()
    wb.setTool('select')
    wb.pointerDown(700, 500, 0, false)
    wb.pointerMove(100, 50)
    wb.pointerUp()
    const parsed = JSON.parse(wb.exportSelection()!.json)
    expect(parsed.selection.width).toBeGreaterThan(0)
    expect(parsed.selection.height).toBeGreaterThan(0)
    expect(parsed.selection.x).toBeGreaterThanOrEqual(0)
    expect(parsed.selection.y).toBeGreaterThanOrEqual(0)
    expect(parsed.selection.x + parsed.selection.width).toBeLessThanOrEqual(512)
  })

  it('无选择时导出为 null；清除后同样为 null', () => {
    const { wb } = setup()
    expect(wb.exportSelection()).toBeNull()
    wb.setTool('select')
    wb.pointerDown(100, 100, 0, false)
    wb.pointerMove(300, 300)
    wb.pointerUp()
    expect(wb.exportSelection()).not.toBeNull()
    wb.clearSelection()
    expect(wb.exportSelection()).toBeNull()
  })
})

describe('Workbench：slotKey', () => {
  it('格式为 level:col:row', () => {
    expect(slotKey(2, 3, 4)).toBe('2:3:4')
  })
})
