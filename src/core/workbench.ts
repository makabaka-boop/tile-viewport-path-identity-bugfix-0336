/**
 * Workbench：把 manifest、本地文件映射、相机与解码调度器整合在一起。
 *
 * - 视口状态全部以原图坐标表达（见 camera.ts）；
 * - 每次相机/视口变化 bumpGeneration 并向调度器下发当前可见瓦片；
 * - 支持「平移 / 框选」两种指针工具，框选结果可导出为原图坐标 JSON。
 */
import {
  clampCenter,
  createInitialCamera,
  minScaleFor,
  panBy,
  screenToImageX,
  screenToImageY,
  zoomAt,
  type Camera
} from './camera'
import { TileScheduler } from './scheduler'
import type { TileRequest } from './decoder'
import { chooseLevel, visibleSlots, type TileSlot } from './levels'
import type {
  DecodeState,
  ImageRect,
  NormalizedManifest,
  NormalizedTile
} from './types'

export type Tool = 'pan' | 'select'

export interface TileLocation {
  tile: NormalizedTile
  file: File | null
}

export interface SlotView extends TileSlot {
  level: number
  key: string
  state: DecodeState
  file: string | null
  error: boolean
}

export interface ExportResult {
  json: string
  rect: ImageRect
}

export interface WorkbenchOptions {
  manifest: NormalizedManifest
  /** manifest 引用路径 => 本地 File（缺失瓦片不在表中）。 */
  files: Map<string, File>
  scheduler: TileScheduler
}

const WHEEL_ZOOM_STEP = 1.0015

export class Workbench {
  readonly manifest: NormalizedManifest
  readonly files: Map<string, File>
  readonly scheduler: TileScheduler

  camera: Camera
  tool: Tool = 'pan'
  /** 已确认选择（原图坐标，标准化为正宽高）。 */
  selection: ImageRect | null = null
  /** 正在拖拽的框选（屏幕坐标锚点 + 当前指针位置）。 */
  selecting: { startX: number; startY: number; currentX: number; currentY: number } | null = null
  panning: boolean = false

  private generation = 0
  private panLast: { x: number; y: number } | null = null
  private dirty = true
  private readonly changeListeners = new Set<() => void>()

  constructor(opts: WorkbenchOptions) {
    this.manifest = opts.manifest
    this.files = opts.files
    this.scheduler = opts.scheduler
    this.camera = createInitialCamera({
      viewportWidth: 1,
      viewportHeight: 1,
      imageWidth: this.manifest.width,
      imageHeight: this.manifest.height
    })
  }

  get imageWidth(): number {
    return this.manifest.width
  }

  get imageHeight(): number {
    return this.manifest.height
  }

  /** 允许缩到「最粗金字塔层原生分辨率」；单层图像则允许适应窗口。 */
  get minScale(): number {
    const coarsest = this.manifest.layers[this.manifest.layers.length - 1]
    const layerScale = this.imageWidth > 0 ? coarsest.width / this.imageWidth : 1
    const fit = minScaleFor(
      this.imageWidth,
      this.imageHeight,
      this.camera.viewportWidth,
      this.camera.viewportHeight
    )
    return Math.min(layerScale, fit)
  }

  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn)
    return () => this.changeListeners.delete(fn)
  }

  private emitChange(): void {
    this.changeListeners.forEach((fn) => fn())
  }

  markDirty(): void {
    this.dirty = true
  }

  consumeDirty(): boolean {
    const d = this.dirty
    this.dirty = false
    return d
  }

  setViewport(width: number, height: number): void {
    if (width <= 0 || height <= 0) return
    this.camera = clampCenter(
      { ...this.camera, viewportWidth: width, viewportHeight: height },
      this.imageWidth,
      this.imageHeight
    )
    this.updateVisible()
    this.dirty = true
  }

  /** 重置为适应窗口的初始视图。 */
  resetView(): void {
    this.camera = createInitialCamera({
      viewportWidth: this.camera.viewportWidth,
      viewportHeight: this.camera.viewportHeight,
      imageWidth: this.imageWidth,
      imageHeight: this.imageHeight
    })
    this.updateVisible()
    this.dirty = true
    this.emitChange()
  }

  setTool(tool: Tool): void {
    this.tool = tool
    this.selecting = null
    this.panning = false
    this.panLast = null
    this.emitChange()
  }

  zoomAtPoint(screenX: number, screenY: number, factor: number): void {
    this.camera = zoomAt(this.camera, screenX, screenY, factor, this.minScale)
    this.updateVisible()
    this.dirty = true
    this.emitChange()
  }

  /** 滚轮缩放：以鼠标位置为锚点，deltaMode 已归一化为像素。 */
  handleWheel(screenX: number, screenY: number, deltaY: number, deltaMode: number): void {
    const pixels = deltaMode === 1 ? deltaY * 16 : deltaY
    const factor = Math.pow(WHEEL_ZOOM_STEP, -pixels)
    this.zoomAtPoint(screenX, screenY, factor)
  }

  pointerDown(screenX: number, screenY: number, button: number, shiftKey: boolean): void {
    const wantsSelect = this.tool === 'select' && !shiftKey && button === 0
    const wantsPan = (!wantsSelect && button === 0) || button === 1
    if (wantsSelect) {
      this.selecting = { startX: screenX, startY: screenY, currentX: screenX, currentY: screenY }
    } else if (wantsPan) {
      this.panning = true
      this.panLast = { x: screenX, y: screenY }
    }
    this.dirty = true
    this.emitChange()
  }

  pointerMove(screenX: number, screenY: number): void {
    if (this.panning && this.panLast) {
      this.camera = panBy(
        this.camera,
        screenX - this.panLast.x,
        screenY - this.panLast.y,
        this.imageWidth,
        this.imageHeight
      )
      this.panLast = { x: screenX, y: screenY }
      this.updateVisible()
    }
    if (this.selecting) {
      this.selecting.currentX = screenX
      this.selecting.currentY = screenY
    }
    this.dirty = true
    this.emitChange()
  }

  pointerUp(): void {
    if (this.selecting) {
      const rect = this.draftSelectionImageRect()
      // 宽高过小视为点击，清除选择。
      if (rect && rect.width >= 1 && rect.height >= 1) {
        this.selection = rect
      } else {
        this.selection = null
      }
      this.selecting = null
    }
    this.panning = false
    this.panLast = null
    this.dirty = true
    this.emitChange()
  }

  clearSelection(): void {
    this.selection = null
    this.selecting = null
    this.dirty = true
    this.emitChange()
  }

  /** 屏幕坐标 -> 原图坐标（供 UI 读数）。 */
  toImagePoint(screenX: number, screenY: number): { x: number; y: number } {
    return { x: screenToImageX(this.camera, screenX), y: screenToImageY(this.camera, screenY) }
  }

  /** 框选草稿（正在拖拽）转原图矩形。 */
  private draftSelectionImageRect(): ImageRect | null {
    const d = this.selecting
    if (!d) return null
    const a = this.toImagePoint(d.startX, d.startY)
    const b = this.toImagePoint(d.currentX, d.currentY)
    return normalizeRect(
      { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y },
      this.imageWidth,
      this.imageHeight
    )
  }

  /** 当前生效选择（拖拽中优先显示草稿），原图坐标。 */
  effectiveSelection(): ImageRect | null {
    return this.selecting ? this.draftSelectionImageRect() : this.selection
  }

  /** 计算当前视口下应显示层级的全部槽位及其解码状态（渲染器输入）。 */
  computeSlots(): SlotView[] {
    const layer = chooseLevel(this.manifest, this.camera)
    const slots = visibleSlots(this.manifest, layer, this.camera)
    return slots.map((slot) => {
      const tile = layer.tiles.get(`${slot.col}:${slot.row}`)
      const file = tile ? this.files.get(tile.file) ?? null : null
      const key = slotKey(layer.level, slot.col, slot.row)
      let state: DecodeState = 'missing'
      let error = false
      if (tile && file) {
        if (this.scheduler.hasError(key)) {
          state = 'loading'
          error = true
        } else if (this.scheduler.getBitmap(key)) {
          state = 'ready'
        } else {
          state = 'loading'
        }
      }
      return {
        ...slot,
        level: layer.level,
        key,
        state,
        file: tile?.file ?? null,
        error
      }
    })
  }

  private updateVisible(): void {
    this.generation += 1
    const layer = chooseLevel(this.manifest, this.camera)
    const slots = visibleSlots(this.manifest, layer, this.camera)
    const requests: TileRequest[] = []
    for (const slot of slots) {
      const tile = layer.tiles.get(`${slot.col}:${slot.row}`)
      if (!tile) continue
      const file = this.files.get(tile.file)
      if (!file) continue
      requests.push({
        key: slotKey(layer.level, slot.col, slot.row),
        file,
        expectedWidth: tile.width,
        expectedHeight: tile.height
      })
    }
    this.scheduler.setVisible(this.generation, requests)
  }

  /** 首次挂载后激活（视口尺寸已知时调用）。 */
  activate(): void {
    this.updateVisible()
    this.dirty = true
  }

  /**
   * 导出当前框选为原图坐标 JSON。
   * 无有效选择时返回 null。
   */
  exportSelection(): ExportResult | null {
    const rect = this.selection
    if (!rect) return null
    const payload = {
      coordinateSpace: 'image',
      image: { width: this.imageWidth, height: this.imageHeight },
      selection: {
        x: round6(rect.x),
        y: round6(rect.y),
        width: round6(rect.width),
        height: round6(rect.height)
      },
      level0Tiles: tilesForRect(this.manifest, rect)
    }
    return { json: JSON.stringify(payload, null, 2), rect }
  }

  dispose(): void {
    this.changeListeners.clear()
  }
}

export function slotKey(level: number, col: number, row: number): string {
  return `${level}:${col}:${row}`
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6
}

function normalizeRect(r: ImageRect, maxW: number, maxH: number): ImageRect {
  const x = Math.max(0, Math.min(r.x, r.x + r.width))
  const y = Math.max(0, Math.min(r.y, r.y + r.height))
  const x2 = Math.min(maxW, Math.max(r.x, r.x + r.width))
  const y2 = Math.min(maxH, Math.max(r.y, r.y + r.height))
  return { x, y, width: Math.max(0, x2 - x), height: Math.max(0, y2 - y) }
}

function tilesForRect(
  manifest: NormalizedManifest,
  rect: ImageRect
): Array<{ level: number; col: number; row: number; file: string | null }> {
  const base = manifest.layers.find((l) => l.level === 0) ?? manifest.layers[0]
  const ts = base.tileSize
  const c0 = Math.max(0, Math.floor(rect.x / ts))
  const r0 = Math.max(0, Math.floor(rect.y / ts))
  const c1 = Math.min(base.cols - 1, Math.floor((rect.x + rect.width) / ts))
  const r1 = Math.min(base.rows - 1, Math.floor((rect.y + rect.height) / ts))
  const out: Array<{ level: number; col: number; row: number; file: string | null }> = []
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const tile = base.tiles.get(`${col}:${row}`)
      out.push({ level: 0, col, row, file: tile?.file ?? null })
    }
  }
  return out
}
