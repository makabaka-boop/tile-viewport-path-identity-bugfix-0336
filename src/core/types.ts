/**
 * 多分辨率 manifest 与工作台核心类型。
 *
 * 约定：
 * - 原图坐标空间即第 0 层像素空间（level 0 为最高分辨率层）。
 * - 每层瓦片为 256×256，右/下边缘允许不足。
 * - level k 相对原图的比例为 2^-k（manifest 也可给出非标准宽高，按宽高实际比例缩放）。
 */

export interface ManifestTileJSON {
  col: number
  row: number
  file: string
  /** 该瓦片在当前层级像素空间中的实际宽，边缘瓦片可小于 256。缺省时按网格推算。 */
  width?: number
  /** 该瓦片在当前层级像素空间中的实际高。 */
  height?: number
}

export interface ManifestLayerJSON {
  level: number
  width: number
  height: number
  tileSize?: number
  tiles: ManifestTileJSON[]
}

export interface ManifestJSON {
  name?: string
  width: number
  height: number
  tileSize?: number
  layers: ManifestLayerJSON[]
}

/** 校验/归一化后的单个瓦片定义。 */
export interface NormalizedTile {
  col: number
  row: number
  /** 层级像素空间内的宽（边缘允许 < tileSize）。 */
  width: number
  /** 层级像素空间内的高。 */
  height: number
  /** manifest 中引用的文件路径（相对路径，正斜杠）。 */
  file: string
}

export interface NormalizedLayer {
  level: number
  width: number
  height: number
  tileSize: number
  cols: number
  rows: number
  /** key 为 `${col}:${row}` */
  tiles: Map<string, NormalizedTile>
}

export interface NormalizedManifest {
  name: string
  width: number
  height: number
  tileSize: number
  layers: NormalizedLayer[]
}

export type IssueSeverity = 'error' | 'warning'

export interface Issue {
  severity: IssueSeverity
  code: string
  message: string
}

/** 归一化结果：errors 非空时 manifest 不可导入。 */
export interface ManifestParseResult {
  manifest: NormalizedManifest | null
  issues: Issue[]
}

/** 原图坐标系下的矩形（可能是浮点值，宽高恒非负）。 */
export interface ImageRect {
  x: number
  y: number
  width: number
  height: number
}

export type DecodeState = 'missing' | 'loading' | 'ready'
