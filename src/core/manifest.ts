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

/**
 * 将 manifest 中的路径归一化为相对、正斜杠形式；绝对路径 / `..` 越界、
 * 空片段（`a//b`、`a/`）返回 null。
 *
 * 所有等价的「当前目录」片段都会被折叠（包括路径中间的 `.`），因此
 * `tiles/./l0/0_0.png` 与 `./tiles/l0/0_0.png` 归一化结果一致——否则同一路径
 * 的不同等价写法会绕过全局唯一性检查，也无法与本地文件正确配对。
 */
export function normalizeFilePath(raw: string): string | null {
  const p = raw.replace(/\\/g, '/')
  if (p.length === 0 || p.startsWith('/')) return null
  const rawParts = p.split('/')
  // 空片段（a//b、a/、/a 之外的尾斜杠等）一律拒绝，不做静默折叠。
  if (rawParts.some((seg) => seg.length === 0)) return null
  // 仅折叠等价的当前目录片段，保证等价写法归一化为同一结果。
  const parts = rawParts.filter((seg) => seg !== '.')
  if (parts.length === 0) return null
  if (parts.some((seg) => seg === '..')) return null
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

export interface AmbiguousRef {
  /** manifest 引用路径。 */
  ref: string
  /** 无法确定归属的候选本地文件展示名（webkitRelativePath，无目录信息时为 basename）。 */
  candidates: string[]
}

export interface ResolvedFiles {
  /** manifest 文件路径 => 用户选择的本地文件；缺失瓦片不在此表中。 */
  byPath: Map<string, File>
  /** 被引用但未在所选文件中找到的路径（查看器显示占位）。 */
  missing: string[]
  /** 匹配到多个候选、无法唯一确定归属的引用；按缺失处理。 */
  ambiguous: AmbiguousRef[]
  /** 已选择但未被任何瓦片引用、也未卷入任何歧义的文件名。 */
  unused: string[]
}

function webkitRelativePathOf(f: File): string {
  const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath
  return typeof rel === 'string' ? rel.replace(/\\/g, '/') : ''
}

/** 本地文件的展示名：目录选择时保留浏览器给出的相对路径，否则为 basename。 */
export function fileDisplayName(f: File): string {
  return webkitRelativePathOf(f) || f.name
}

interface IndexedFile {
  file: File
  display: string
  /** 目录选择时的相对路径（如 setA/tiles/l0/0_0.png），平铺选择为空。 */
  rel: string
  /** rel 的全部后缀（含完整 rel 自身），平铺选择为空数组。 */
  suffixes: string[]
  base: string
}

function indexFiles(files: File[]): IndexedFile[] {
  return files.map((file) => {
    const rel = webkitRelativePathOf(file)
    const parts = rel ? rel.split('/') : []
    const suffixes: string[] = []
    for (let idx = 0; idx < parts.length; idx++) {
      suffixes.push(parts.slice(idx).join('/'))
    }
    return { file, display: rel || file.name, rel, suffixes, base: file.name }
  })
}

/**
 * 二分匹配（引用 <=> 本地文件），按连通分量消歧：
 * - 恰好 1 个引用 + 1 个候选 => 唯一归属；
 * - 其余任何形态（多个候选、多个引用共享同一文件）=> 整组引用按缺失处理，
 *   整组文件标记为「卷入歧义」，不计入 unused。
 *
 * 结果只取决于边的集合，与浏览器返回文件 / 遍历引用的顺序完全无关——
 * 否则从父目录导入两套末尾路径相同的瓦片树时，仅改变文件顺序就会让画布
 * 静默显示另一套瓦片的像素。
 */
function resolveByEdges(
  refs: string[],
  indexed: IndexedFile[],
  hasEdge: (ref: string, item: IndexedFile) => boolean
): { assigned: Map<string, File>; ambiguous: AmbiguousRef[]; quarantined: Set<File> } {
  const assigned = new Map<string, File>()
  const ambiguous: AmbiguousRef[] = []
  const quarantined = new Set<File>()
  if (refs.length === 0 || indexed.length === 0) return { assigned, ambiguous, quarantined }

  // 邻接表：引用侧节点 r<i>，文件侧节点 f<i>。
  const refAdj = refs.map((ref) => {
    const out: number[] = []
    indexed.forEach((item, fi) => {
      if (hasEdge(ref, item)) out.push(fi)
    })
    return out
  })
  const fileAdj = indexed.map(() => [] as number[])
  refAdj.forEach((neighbors, ri) => {
    for (const fi of neighbors) fileAdj[fi].push(ri)
  })

  const visited = new Set<string>()
  for (let ri = 0; ri < refs.length; ri++) {
    const root = `r${ri}`
    if (visited.has(root)) continue
    const compRefs = new Set<number>()
    const compFiles = new Set<number>()
    const stack: Array<{ side: 'r' | 'f'; i: number }> = [{ side: 'r', i: ri }]
    while (stack.length) {
      const node = stack.pop()!
      const key = `${node.side}${node.i}`
      if (visited.has(key)) continue
      visited.add(key)
      if (node.side === 'r') {
        compRefs.add(node.i)
        for (const fi of refAdj[node.i]) {
          if (!visited.has(`f${fi}`)) stack.push({ side: 'f', i: fi })
        }
      } else {
        compFiles.add(node.i)
        for (const otherRi of fileAdj[node.i]) {
          if (!visited.has(`r${otherRi}`)) stack.push({ side: 'r', i: otherRi })
        }
      }
    }

    if (compRefs.size === 1 && compFiles.size === 1) {
      const onlyRef = [...compRefs][0]
      const onlyFile = [...compFiles][0]
      assigned.set(refs[onlyRef], indexed[onlyFile].file)
    } else if (compFiles.size > 0) {
      // 有候选但无法一一对应（多候选 / 多引用共享同一文件）=> 歧义。
      // 候选为 0 的分量只是「缺失」，不在这里报告（由 missing 体现）。
      const fileItems = [...compFiles].map((fi) => indexed[fi])
      const candidates = fileItems.map((it) => it.display).sort()
      for (const fi of compFiles) quarantined.add(indexed[fi].file)
      for (const r of compRefs) {
        ambiguous.push({ ref: refs[r], candidates })
      }
    }
  }
  return { assigned, ambiguous, quarantined }
}

/**
 * 将归一化 manifest 引用的路径解析到用户选择的本地文件。绝不读取文件内容，
 * 仅按相对路径后缀 / basename 匹配。匹配对文件与引用的遍历顺序完全不敏感：
 * 命中多候选时一律按缺失处理并报告歧义，而不是静默挑中顺序上的第一个文件。
 */
export function resolveFiles(manifest: NormalizedManifest, files: File[]): ResolvedFiles {
  const referenced = new Set<string>()
  manifest.layers.forEach((l) => l.tiles.forEach((t) => referenced.add(t.file)))
  const allRefs = [...referenced].sort()
  const indexed = indexFiles(files)

  // 第一轮：路径级匹配。
  // - 目录选择：引用必须是 webkitRelativePath 的后缀（完整 rel 也注册为后缀）；
  // - 平铺选择：仅允许 basename 全等。
  // 多个文件结尾路径相同时（父目录下两套瓦片树），连通分量为 1 引用 × N 文件
  // => 歧义，按缺失处理，候选文件不计入 unused。
  const phase1 = resolveByEdges(allRefs, indexed, (ref, item) => {
    if (item.rel) return item.suffixes.includes(ref)
    return item.base === ref
  })

  // 第二轮：仅对仍未命中的引用做 basename 兜底，候选排除已唯一分配 /
  // 已卷入路径级歧义的文件。两个引用共用同一 basename 时同样以连通分量消歧。
  const assignedPhase1 = new Set<File>(phase1.assigned.values())
  const remaining = allRefs.filter((ref) => !phase1.assigned.has(ref))
  const available = indexed.filter(
    (item) => !assignedPhase1.has(item.file) && !phase1.quarantined.has(item.file)
  )
  const phase2 = resolveByEdges(remaining, available, (ref, item) => {
    const base = ref.split('/').pop() ?? ref
    return item.base === base
  })

  const byPath = new Map<string, File>(phase1.assigned)
  for (const [ref, file] of phase2.assigned) byPath.set(ref, file)

  const ambiguous = [...phase1.ambiguous, ...phase2.ambiguous].sort((a, b) =>
    a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0
  )
  const quarantined = new Set<File>([...phase1.quarantined, ...phase2.quarantined])

  const missing = allRefs.filter((ref) => !byPath.has(ref)).sort()
  // 歧义引用同时落在 missing 中（画布显示占位）；ambiguous 提供候选明细。

  const assignedFiles = new Set<File>(byPath.values())
  const unused = files
    .filter((f) => !assignedFiles.has(f) && !quarantined.has(f))
    .map((f) => f.name)

  return { byPath, missing, ambiguous, unused }
}
