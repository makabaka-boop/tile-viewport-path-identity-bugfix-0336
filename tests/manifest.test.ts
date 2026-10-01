import { describe, expect, it } from 'vitest'
import { normalizeFilePath, parseManifest, resolveFiles } from '../src/core/manifest'
import type { ManifestJSON } from '../src/core/types'
import { makeDirFile, makeFile } from './helpers'

function tiles2x2(filePrefix: string): ManifestJSON['layers'][number]['tiles'] {
  // 512×512 图像，256 瓦片 => 2×2
  return [
    { col: 0, row: 0, file: `${filePrefix}/0_0.png` },
    { col: 1, row: 0, file: `${filePrefix}/0_1.png` },
    { col: 0, row: 1, file: `${filePrefix}/1_0.png` },
    { col: 1, row: 1, file: `${filePrefix}/1_1.png` }
  ]
}

function validManifest(): ManifestJSON {
  return {
    name: '示例',
    width: 512,
    height: 512,
    tileSize: 256,
    layers: [
      { level: 0, width: 512, height: 512, tiles: tiles2x2('L0') },
      { level: 1, width: 256, height: 256, tiles: [{ col: 0, row: 0, file: 'L1/0_0.png' }] }
    ]
  }
}

describe('manifest 路径归一化', () => {
  it('接受普通相对路径并统一反斜杠', () => {
    expect(normalizeFilePath('a/b\\c.png')).toBe('a/b/c.png')
    expect(normalizeFilePath('./x.png')).toBe('x.png')
  })
  it('折叠路径中任意位置的 . 片段（等价路径归一化为同一结果）', () => {
    expect(normalizeFilePath('tiles/./l0/0_0.png')).toBe('tiles/l0/0_0.png')
    expect(normalizeFilePath('./a/./b.png')).toBe('a/b.png')
    expect(normalizeFilePath('a/././b.png')).toBe('a/b.png')
  })
  it('拒绝绝对路径与 .. 越界', () => {
    expect(normalizeFilePath('/etc/passwd')).toBeNull()
    expect(normalizeFilePath('../x.png')).toBeNull()
    expect(normalizeFilePath('a/../b.png')).toBeNull()
    expect(normalizeFilePath('')).toBeNull()
    expect(normalizeFilePath('.')).toBeNull()
    expect(normalizeFilePath('a//b.png')).toBeNull()
    expect(normalizeFilePath('a/')).toBeNull()
  })
})

describe('等价目录片段不得绕过文件唯一性', () => {
  it('tiles/./l0/0_0.png 与 tiles/l0/0_0.png 判为同一文件', () => {
    const m: ManifestJSON = {
      width: 512,
      height: 256,
      layers: [
        {
          level: 0,
          width: 512,
          height: 256,
          tiles: [
            { col: 0, row: 0, file: 'tiles/./l0/0_0.png' },
            { col: 1, row: 0, width: 256, height: 256, file: 'tiles/l0/0_0.png' }
          ]
        }
      ]
    }
    const r = parseManifest(m)
    expect(r.manifest).toBeNull()
    expect(r.issues.some((i) => i.code === 'tile.duplicate_file')).toBe(true)
  })
})

describe('manifest 校验', () => {
  it('合法 manifest 通过并推导网格与尺寸', () => {
    const r = parseManifest(validManifest())
    expect(r.issues.filter((i) => i.severity === 'error')).toHaveLength(0)
    expect(r.manifest).not.toBeNull()
    const l0 = r.manifest!.layers[0]
    expect(l0.cols).toBe(2)
    expect(l0.rows).toBe(2)
    expect(l0.tiles.get('0:0')!.width).toBe(256)
    expect(l0.tiles.get('1:1')!.width).toBe(256)
  })

  it('边缘瓦片允许不足 256', () => {
    const m = validManifest()
    m.width = 400
    m.height = 300
    m.layers[0] = {
      level: 0,
      width: 400,
      height: 300,
      tiles: [
        { col: 0, row: 0, file: 'a.png' },
        { col: 1, row: 0, file: 'b.png' }, // 宽 144
        { col: 0, row: 1, file: 'c.png' }, // 高 44
        { col: 1, row: 1, file: 'd.png' } // 144×44
      ]
    }
    const r = parseManifest(m)
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([])
    const l0 = r.manifest!.layers[0]
    expect(l0.cols).toBe(2)
    expect(l0.rows).toBe(2)
    expect(l0.tiles.get('1:1')!.width).toBe(144)
    expect(l0.tiles.get('1:1')!.height).toBe(44)
  })

  it('非边缘瓦片小于 256 报错', () => {
    const m = validManifest()
    m.layers[0].tiles[0] = { col: 0, row: 0, width: 200, file: 'x.png' }
    const r = parseManifest(m)
    expect(r.manifest).toBeNull()
    expect(r.issues.some((i) => i.code === 'tile.width')).toBe(true)
  })

  it('坐标越界报错', () => {
    const m = validManifest()
    m.layers[0].tiles[0] = { col: 5, row: 0, file: 'x.png' }
    const r = parseManifest(m)
    expect(r.issues.some((i) => i.code === 'tile.col')).toBe(true)
  })

  it('同层坐标重复报错', () => {
    const m = validManifest()
    m.layers[0].tiles[1] = { col: 0, row: 0, file: 'dup.png' }
    const r = parseManifest(m)
    expect(r.issues.some((i) => i.code === 'tile.duplicate_coord')).toBe(true)
  })

  it('文件名跨层必须唯一', () => {
    const m = validManifest()
    m.layers[1].tiles[0].file = 'L0/0_0.png'
    const r = parseManifest(m)
    expect(r.issues.some((i) => i.code === 'tile.duplicate_file')).toBe(true)
    expect(r.manifest).toBeNull()
  })

  it('level 0 尺寸与原图不一致报错', () => {
    const m = validManifest()
    m.layers[0].width = 999
    const r = parseManifest(m)
    expect(r.issues.some((i) => i.code === 'layer.base_size')).toBe(true)
  })

  it('高层尺寸大于低层报错（单调不增）', () => {
    const m = validManifest()
    m.layers[1].width = 512
    m.layers[1].height = 600
    const r = parseManifest(m)
    expect(r.issues.some((i) => i.code === 'layer.size_grows')).toBe(true)
  })

  it('缺失/空 layers 报错', () => {
    expect(parseManifest({ width: 1, height: 1, layers: [] }).manifest).toBeNull()
    expect(parseManifest(null).manifest).toBeNull()
    expect(parseManifest('nope').manifest).toBeNull()
  })

  it('非正整数尺寸报错', () => {
    const r = parseManifest({ width: 0, height: -1, layers: [] })
    expect(r.issues.some((i) => i.code === 'manifest.width')).toBe(true)
  })
})

describe('本地文件解析（不上传内容）', () => {
  it('按 basename 解析，缺失文件列入 missing', () => {
    const m = validManifest()
    // 让 L1 瓦片使用独立 basename，避免与 L0 的 0_0.png 重名
    m.layers[1].tiles = [{ col: 0, row: 0, file: 'overview.png' }]
    const { manifest } = parseManifest(m)
    expect(manifest).not.toBeNull()
    // 提供全部 4 个 L0 文件；故意缺 overview.png。
    const files = ['0_0.png', '0_1.png', '1_0.png', '1_1.png'].map((n) => makeFile(n))

    const res = resolveFiles(manifest!, files)
    expect(res.byPath.size).toBe(4)
    expect(res.missing).toEqual(['overview.png'])
  })

  it('多引用共用同一 basename 且无法消歧时全部按缺失处理', () => {
    // L0 与 L1 的瓦片都叫 0_0.png，仅平铺选择一个同名文件 => 无法确定归属
    const m: ManifestJSON = {
      width: 256,
      height: 256,
      layers: [
        { level: 0, width: 256, height: 256, tiles: [{ col: 0, row: 0, file: 'L0/0_0.png' }] },
        { level: 1, width: 128, height: 128, tiles: [{ col: 0, row: 0, width: 128, height: 128, file: 'L1/0_0.png' }] }
      ]
    }
    const parsed = parseManifest(m)
    const res = resolveFiles(parsed.manifest!, [makeFile('0_0.png')])
    expect(res.byPath.size).toBe(0)
    expect(res.missing.sort()).toEqual(['L0/0_0.png', 'L1/0_0.png'])
    expect(res.ambiguous.map((a) => a.ref).sort()).toEqual(['L0/0_0.png', 'L1/0_0.png'])
    // 卷入歧义的唯一文件不应再被计为「多余文件」
    expect(res.unused).toEqual([])
  })

  it('多余文件列入 unused', () => {
    const m = validManifest()
    m.layers[1].tiles = [{ col: 0, row: 0, file: 'overview.png' }]
    const { manifest } = parseManifest(m)
    const files = [
      ...['0_0.png', '0_1.png', '1_0.png', '1_1.png'].map((n) => makeFile(n)),
      makeFile('overview.png'),
      makeFile('random.txt')
    ]
    const res = resolveFiles(manifest!, files)
    expect(res.byPath.size).toBe(5)
    expect(res.missing).toEqual([])
    expect(res.unused).toEqual(['random.txt'])
  })
})

describe('父目录下两套末尾路径相同的瓦片树', () => {
  function singleTileManifest(): ManifestJSON {
    return {
      width: 256,
      height: 256,
      layers: [
        { level: 0, width: 256, height: 256, tiles: [{ col: 0, row: 0, file: 'tiles/l0/0_0.png' }] }
      ]
    }
  }

  it('改变浏览器返回文件的顺序，解析结果完全一致：按歧义/缺失处理而非静默选一套', () => {
    const { manifest } = parseManifest(singleTileManifest())
    const fromA = makeDirFile('imports/A/tiles/l0/0_0.png')
    const fromB = makeDirFile('imports/B/tiles/l0/0_0.png')

    const r1 = resolveFiles(manifest!, [fromA, fromB])
    const r2 = resolveFiles(manifest!, [fromB, fromA])

    for (const r of [r1, r2]) {
      expect(r.byPath.size).toBe(0)
      expect(r.missing).toEqual(['tiles/l0/0_0.png'])
      expect(r.ambiguous).toHaveLength(1)
      expect(r.ambiguous[0].ref).toBe('tiles/l0/0_0.png')
      expect(r.ambiguous[0].candidates.sort()).toEqual([
        'imports/A/tiles/l0/0_0.png',
        'imports/B/tiles/l0/0_0.png'
      ])
      // 两个候选都不是「多余文件」——它们正是无法消歧的来源
      expect(r.unused).toEqual([])
    }
  })

  it('只导入一套瓦片树时正常唯一命中（不因后缀机制误报歧义）', () => {
    const { manifest } = parseManifest(singleTileManifest())
    const f = makeDirFile('shoot-2026/tiles/l0/0_0.png')
    const r = resolveFiles(manifest!, [f])
    expect(r.byPath.get('tiles/l0/0_0.png')).toBe(f)
    expect(r.missing).toEqual([])
    expect(r.ambiguous).toEqual([])
    expect(r.unused).toEqual([])
  })

  it('一套目录树 + 一个平铺同名文件：目录路径信息优先唯一归属，平铺文件列为多余（顺序无关）', () => {
    const { manifest } = parseManifest(singleTileManifest())
    const dir = makeDirFile('A/tiles/l0/0_0.png')
    const flat = makeFile('0_0.png')
    const r1 = resolveFiles(manifest!, [dir, flat])
    const r2 = resolveFiles(manifest!, [flat, dir])
    for (const r of [r1, r2]) {
      expect(r.byPath.size).toBe(1)
      expect(r.byPath.get('tiles/l0/0_0.png')).toBe(dir)
      expect(r.ambiguous).toEqual([])
      expect(r.unused).toEqual(['0_0.png'])
    }
  })

  it('两层引用后缀相同、磁盘仅一个文件同时满足 => 歧义（不能把同一像素同时判给两处）', () => {
    const m: ManifestJSON = {
      width: 256,
      height: 256,
      layers: [
        { level: 0, width: 256, height: 256, tiles: [{ col: 0, row: 0, file: 'l0/0_0.png' }] },
        { level: 1, width: 128, height: 128, tiles: [{ col: 0, row: 0, width: 128, height: 128, file: 'l1/0_0.png' }] }
      ]
    }
    const parsed = parseManifest(m)
    // 一个很深的目录文件，其路径后缀同时包含 l0/0_0.png 与 l1/0_0.png 不可能，
    // 但平铺选择的单文件 basename 兜底正是这个形态：
    const res = resolveFiles(parsed.manifest!, [makeFile('0_0.png')])
    expect(res.byPath.size).toBe(0)
    expect(res.ambiguous.map((a) => a.ref).sort()).toEqual(['l0/0_0.png', 'l1/0_0.png'])
  })
})
