import { describe, expect, it } from 'vitest'
import { normalizeFilePath, parseManifest, resolveFiles } from '../src/core/manifest'
import type { ManifestJSON } from '../src/core/types'
import { makeFile, makeRelFile } from './helpers'

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
  it('折叠所有 . 片段，保证等价目录片段归一为同一路径', () => {
    expect(normalizeFilePath('a/./b.png')).toBe('a/b.png')
    expect(normalizeFilePath('././x.png')).toBe('x.png')
    expect(normalizeFilePath('a/b/.')).toBe('a/b')
    expect(normalizeFilePath('.')).toBeNull()
    expect(normalizeFilePath('./')).toBeNull()
  })
  it('拒绝绝对路径、.. 越界与空片段', () => {
    expect(normalizeFilePath('/etc/passwd')).toBeNull()
    expect(normalizeFilePath('../x.png')).toBeNull()
    expect(normalizeFilePath('a/../b.png')).toBeNull()
    expect(normalizeFilePath('a//b.png')).toBeNull()
    expect(normalizeFilePath('')).toBeNull()
  })
  it('等价目录片段不能绕过文件名唯一性检查', () => {
    const m = validManifest()
    // 第二块瓦片用 ./L0/0_0.png 等 Price 写法引用同一文件
    m.layers[0].tiles[1] = { col: 1, row: 0, file: './L0/./0_0.png' }
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
    expect(res.ambiguous.length).toBe(2)
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

  it('两套末尾路径相同的瓦片：后缀冲突一律歧义，结果与文件顺序无关', () => {
    const m = validManifest()
    // 清单只引用 4 个 L0 瓦片（L0/0_0.png …）
    m.layers[1].tiles = [{ col: 0, row: 0, file: 'overview.png' }]
    const { manifest } = parseManifest(m)

    // 从同一父目录导入 A、B 两套瓦片，二者末尾路径完全相同。
    const setA = ['L0/0_0.png', 'L0/0_1.png', 'L0/1_0.png', 'L0/1_1.png', 'overview.png'].map((p) =>
      makeRelFile(`shootA/tiles/${p}`)
    )
    const setB = ['L0/0_0.png', 'L0/0_1.png', 'L0/1_0.png', 'L0/1_1.png', 'overview.png'].map((p) =>
      makeRelFile(`shootB/tiles/${p}`)
    )

    const resolve = (files: File[]) => {
      const r = resolveFiles(manifest!, files)
      return {
        resolved: [...r.byPath.entries()].sort(([a], [b]) => a.localeCompare(b)),
        missing: [...r.missing].sort(),
        ambiguous: [...r.ambiguous].sort(),
        unused: [...r.unused].sort()
      }
    }

    const forward = resolve([...setA, ...setB])
    const reversed = resolve([...setB, ...setA])

    // 无论浏览器先返回哪一套，任何引用都不得静默归属到其中一套。
    expect(forward.resolved).toEqual([])
    expect(forward.ambiguous).toEqual(['L0/0_0.png', 'L0/0_1.png', 'L0/1_0.png', 'L0/1_1.png', 'overview.png'])
    expect(forward.missing).toEqual(forward.ambiguous)
    expect(reversed).toEqual(forward)

    // 两套文件都「参与了歧义」，不产生随顺序互换的多余文件告警。
    expect(forward.unused).toEqual([])
  })

  it('单套目录选择仍按相对路径后缀正常归属', () => {
    const m = validManifest()
    const { manifest } = parseManifest(m)
    const files = [
      ...['0_0.png', '0_1.png', '1_0.png', '1_1.png'].map((n) => makeRelFile(`shoot/tiles/L0/${n}`)),
      makeRelFile('shoot/tiles/L1/0_0.png')
    ]
    const res = resolveFiles(manifest!, files)
    expect(res.byPath.size).toBe(5)
    expect(res.missing).toEqual([])
    expect(res.ambiguous).toEqual([])
    expect(res.unused).toEqual([])
  })
})
