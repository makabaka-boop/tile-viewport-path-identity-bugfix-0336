/**
 * Manifest 解析、结构校验与本地文件解析。
 *
 * 校验内容（错误 => 不可导入；警告 => 可导入但提示）：
 * - 层级尺寸：正整数、level 0 与原图一致、随层级单调不增；
 * - 瓦片坐标：col/row 在网格内、坐标唯一、边缘瓦片尺寸不足 256 合法；
 * - 文件名：全局唯一（归一化后），拒绝绝对路径与 `..` 越界；
 * - 本地文件：缺失引用 => 占位（警告），多余文件 => 警告。
 */
import type {
  Issue,
  ManifestLayerJSON,
  ManifestParseResult,
  ManifestTileJSON,
  NormalizedLayer,
  NormalizedManifest,
  NormalizedTile
} from './types'

const DEFAULT_TILE_SIZE = 256
const MAX_DIMENSION = 1_000_000

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
}

/** 将 manifest 中的路径归一化为相对、正斜杠形式；绝对路径 / `..` 越界返回 null。 */
export function normalizeFilePath(raw: string): string | null {
  const p = raw.replace(/\\/g, '/').replace(/^\.\//, '')
  if (p.length === 0) return null
  if (p.startsWith('/')) return null
  const parts = p.split('/')
  if (parts.some((seg) => seg === '..')) return null
  if (parts.some((seg) => seg.length === 0)) return null
  return parts.join('/')
}

interface RawShape {
  width: unknown
  height: unknown
  tileSize: unknown
  layers: unknown
  name: unknown
}

function asObject(raw: unknown): RawShape | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  return raw as unknown as RawShape
}

/**
 * 解析并校验 manifest。纯函数，不接触文件系统 / DOM，便于测试。
 */
export function parseManifest(raw: unknown): ManifestParseResult {
  const issues: Issue[] = []
  const error = (code: string, message: string): void => {
    issues.push({ severity: 'error', code, message })
  }
  const warning = (code: string, message: string): void => {
    issues.push({ severity: 'warning', code, message })
  }

  const root = asObject(raw)
  if (!root) {
    error('manifest.not_object', 'manifest 必须是 JSON 对象')
    return { manifest: null, issues }
  }

  const name = typeof root.name === 'string' ? root.name : '未命名图像'

  if (!isInt(root.width) || root.width <= 0) {
    error('manifest.width', '原图 width 必须为正整数')
  }
  if (!isInt(root.height) || root.height <= 0) {
    error('manifest.height', '原图 height 必须为正整数')
  }
  const baseWidth = isInt(root.width) ? root.width : 0
  const baseHeight = isInt(root.height) ? root.height : 0
  if (baseWidth > MAX_DIMENSION || baseHeight > MAX_DIMENSION) {
    error('manifest.too_large', `原图尺寸超过 ${MAX_DIMENSION}px 上限`)
  }

  let baseTileSize = DEFAULT_TILE_SIZE
  if (root.tileSize !== undefined) {
    if (!isInt(root.tileSize) || root.tileSize <= 0) {
      error('manifest.tileSize', 'tileSize 必须为正整数')
    } else {
      baseTileSize = root.tileSize
    }
  }

  if (!Array.isArray(root.layers) || root.layers.length === 0) {
    error('layers.empty', 'layers 必须为非空数组')
    return { manifest: null, issues }
  }

  const seenLevels = new Set<number>()
  const normalizedLayers: NormalizedLayer[] = []
  const globalFiles = new Set<string>()

  root.layers.forEach((layerRaw, li) => {
    const where = `layers[${li}]`
    const layerObj = (layerRaw ?? {}) as Partial<ManifestLayerJSON>

    if (typeof layerRaw !== 'object' || layerRaw === null || Array.isArray(layerRaw)) {
      error('layer.not_object', `${where} 必须是对象`)
      return
    }

    const level = layerObj.level
    if (!isInt(level) || level < 0) {
      error('layer.level', `${where}.level 必须为非负整数`)
      return
    }
    if (seenLevels.has(level)) {
      error('layer.duplicate_level', `${where} level ${level} 重复`)
      return
    }
    seenLevels.add(level)

    let tileSize = baseTileSize
    if (layerObj.tileSize !== undefined) {
      if (!isInt(layerObj.tileSize) || layerObj.tileSize <= 0) {
        error('layer.tileSize', `${where}.tileSize 必须为正整数`)
        return
      }
      tileSize = layerObj.tileSize
    }

    const lw = layerObj.width
    const lh = layerObj.height
    if (!isInt(lw) || lw <= 0) {
      error('layer.width', `${where}.width 必须为正整数`)
      return
    }
    if (!isInt(lh) || lh <= 0) {
      error('layer.height', `${where}.height 必须为正整数`)
      return
    }
    if (level === 0 && (lw !== baseWidth || lh !== baseHeight)) {
      error(
        'layer.base_size',
        `level 0 尺寸 ${lw}×${lh} 必须与原图 ${baseWidth}×${baseHeight} 一致`
      )
    }
    if (level > 0 && (lw > baseWidth || lh > baseHeight)) {
      error('layer.size_grows', `${where} 尺寸 ${lw}×${lh} 不得大于 level 0`)
    }
    if (lw > MAX_DIMENSION || lh > MAX_DIMENSION) {
      error('layer.too_large', `${where} 尺寸超过 ${MAX_DIMENSION}px 上限`)
      return
    }

    const cols = Math.ceil(lw / tileSize)
    const rows = Math.ceil(lh / tileSize)
    const tiles = new Map<string, NormalizedTile>()

    const list = layerObj.tiles
    if (!Array.isArray(list)) {
      error('layer.tiles', `${where}.tiles 必须为数组`)
      return
    }

    list.forEach((tileRaw: unknown, ti) => {
      const tWhere = `${where}.tiles[${ti}]`
      if (typeof tileRaw !== 'object' || tileRaw === null || Array.isArray(tileRaw)) {
        error('tile.not_object', `${tWhere} 必须是对象`)
        return
      }
      const tile = tileRaw as Partial<ManifestTileJSON>

      if (!isInt(tile.col) || tile.col < 0 || tile.col >= cols) {
        error('tile.col', `${tWhere}.col 必须在 [0, ${cols - 1}] 内`)
        return
      }
      if (!isInt(tile.row) || tile.row < 0 || tile.row >= rows) {
        error('tile.row', `${tWhere}.row 必须在 [0, ${rows - 1}] 内`)
        return
      }
      const key = `${tile.col}:${tile.row}`
      if (tiles.has(key)) {
        error('tile.duplicate_coord', `${tWhere} 坐标 (${tile.col}, ${tile.row}) 在本层重复`)
        return
      }

      const expectedW = Math.min(tileSize, lw - tile.col * tileSize)
      const expectedH = Math.min(tileSize, lh - tile.row * tileSize)
      let width = expectedW
      let height = expectedH
      if (tile.width !== undefined) {
        if (!isInt(tile.width) || tile.width <= 0) {
          error('tile.width', `${tWhere}.width 必须为正整数`)
          return
        }
        if (tile.width > expectedW) {
          error('tile.width', `${tWhere}.width=${tile.width} 超出网格期望 ${expectedW}`)
          return
        }
        width = tile.width
      }
      if (tile.height !== undefined) {
        if (!isInt(tile.height) || tile.height <= 0) {
          error('tile.height', `${tWhere}.height 必须为正整数`)
          return
        }
        if (tile.height > expectedH) {
          error('tile.height', `${tWhere}.height=${tile.height} 超出网格期望 ${expectedH}`)
          return
        }
        height = tile.height
      }
      // 非边缘瓦片必须铺满；边缘瓦片允许不足（不足 => 透明占位条由查看器补齐）。
      if (expectedW === tileSize && width !== tileSize) {
        error('tile.width', `${tWhere} 非边缘瓦片宽度必须为 ${tileSize}`)
        return
      }
      if (expectedH === tileSize && height !== tileSize) {
        error('tile.height', `${tWhere} 非边缘瓦片高度必须为 ${tileSize}`)
        return
      }
      if (width < expectedW || height < expectedH) {
        warning(
          'tile.edge_partial',
          `${tWhere} 尺寸 ${width}×${height} 小于网格区域 ${expectedW}×${expectedH}`
        )
      }

      if (typeof tile.file !== 'string' || tile.file.trim().length === 0) {
        error('tile.file', `${tWhere}.file 必须为非空字符串`)
        return
      }
      const normalized = normalizeFilePath(tile.file.trim())
      if (normalized === null) {
        error('tile.file_path', `${tWhere}.file "${tile.file}" 必须是相对路径且不得包含 ..`)
        return
      }
      if (globalFiles.has(normalized)) {
        error('tile.duplicate_file', `文件名 "${normalized}" 在 manifest 中不唯一`)
        return
      }
      globalFiles.add(normalized)

      tiles.set(key, { col: tile.col, row: tile.row, width, height, file: normalized })
    })

    normalizedLayers.push({ level, width: lw, height: lh, tileSize, cols, rows, tiles })
  })

  // 层级必须按 level 升序，且尺寸随层级单调不增。
  normalizedLayers.sort((a, b) => a.level - b.level)
  for (let i = 1; i < normalizedLayers.length; i++) {
    const prev = normalizedLayers[i - 1]
    const cur = normalizedLayers[i]
    if (cur.level !== prev.level + 1) {
      warning('layers.gap', `level ${prev.level} 与 ${cur.level} 之间存在跳级`)
    }
    if (cur.width > prev.width || cur.height > prev.height) {
      error('layers.not_monotonic', `level ${cur.level} 尺寸不得大于 level ${prev.level}`)
    }
  }

  if (issues.some((i) => i.severity === 'error')) {
    return { manifest: null, issues }
  }

  return {
    manifest: { name, width: baseWidth, height: baseHeight, tileSize: baseTileSize, layers: normalizedLayers },
    issues
  }
}

export interface ResolvedFiles {
  /** manifest 文件路径 => 用户选择的本地文件；缺失瓦片不在此表中。 */
  byPath: Map<string, File>
  /** 被引用但未在所选文件中找到的路径（查看器显示占位）。 */
  missing: string[]
  /** basename 匹配到多个文件、无法确定的引用路径。 */
  ambiguous: string[]
  /** 已选择但未被任何瓦片引用的文件名。 */
  unused: string[]
}

function webkitRelativePathOf(f: File): string {
  const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath
  return typeof rel === 'string' ? rel.replace(/\\/g, '/') : ''
}

/**
 * 将归一化 manifest 引用的路径解析到用户选择的本地文件。绝不读取文件内容，
 * 仅按相对路径 / 文件名匹配。缺失条目以 missing 路径返回（查看器显示占位）。
 */
export function resolveFiles(manifest: NormalizedManifest, files: File[]): ResolvedFiles {
  const referenced = new Set<string>()
  manifest.layers.forEach((l) => l.tiles.forEach((t) => referenced.add(t.file)))

  // 以「相对路径后缀」索引（兼容目录选择产生的 webkitRelativePath），再以 basename 兜底。
  const byRel = new Map<string, File>()
  const byBase = new Map<string, File[]>()
  for (const f of files) {
    const rel = webkitRelativePathOf(f)
    if (rel) {
      const parts = rel.split('/')
      // a/b/c.png 注册 b/c.png 与 c.png 两个后缀
      for (let idx = 1; idx < parts.length; idx++) {
        const suffix = parts.slice(idx).join('/')
        if (!byRel.has(suffix)) byRel.set(suffix, f)
      }
    }
    if (!byRel.has(f.name)) byRel.set(f.name, f)

    const list = byBase.get(f.name)
    if (list) list.push(f)
    else byBase.set(f.name, [f])
  }

  const byPath = new Map<string, File>()
  const missing: string[] = []
  const ambiguous: string[] = []

  // 第一轮：相对路径后缀精确匹配。
  for (const ref of referenced) {
    const exact = byRel.get(ref)
    if (exact) byPath.set(ref, exact)
  }

  // 第二轮：仅对未命中的引用做 basename 兜底。
  // 同一 basename 若被多个引用共用且无路径级信息消歧，则无法确定归属 => ambiguous。
  const baseRefCount = new Map<string, number>()
  for (const ref of referenced) {
    const base = ref.split('/').pop() ?? ref
    baseRefCount.set(base, (baseRefCount.get(base) ?? 0) + 1)
  }

  for (const ref of referenced) {
    if (byPath.has(ref)) continue
    const base = ref.split('/').pop() ?? ref
    const candidates = byBase.get(base) ?? []
    if ((baseRefCount.get(base) ?? 0) > 1) {
      ambiguous.push(ref)
      missing.push(ref)
    } else if (candidates.length === 0) {
      missing.push(ref)
    } else if (candidates.length > 1) {
      ambiguous.push(ref)
      missing.push(ref)
    } else {
      byPath.set(ref, candidates[0])
    }
  }

  const usedFiles = new Set<File>(byPath.values())
  const unused = files.filter((f) => !usedFiles.has(f)).map((f) => f.name)

  return { byPath, missing, ambiguous, unused }
}
