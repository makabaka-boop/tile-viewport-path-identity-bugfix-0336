/**
 * 层级选择与瓦片槽位计算。
 *
 * level k 相对原图（level 0）的缩放比：
 *   layerScale(k) = layer.width / baseWidth（同时用 height 做安全夹取）
 * 屏幕上该层「层像素」的放大率为 cam.scale / layerScale(k)。
 * 放大率 >= 1 时该层纹理不会被放大（每纹素至少一个屏幕像素），
 * 从中选择分辨率最高（level 最小）的一层显示。
 */
import type { Camera } from './camera'
import { imageToScreenX, imageToScreenY, visibleImageBounds } from './camera'
import type { NormalizedLayer, NormalizedManifest } from './types'

export function layerScale(manifest: NormalizedManifest, layer: NormalizedLayer): number {
  return manifest.width > 0 ? layer.width / manifest.width : 1
}

/** 当前相机下应当显示的层级。 */
export function chooseLevel(manifest: NormalizedManifest, cam: Camera): NormalizedLayer {
  // 从最低分辨率层向上找，保留所有「纹素 -> 屏幕 >= 1（不放大纹理）」的层，
  // 最终取其中分辨率最高（level 最小）的一层；若全部不满足则停在最低层。
  let chosen = manifest.layers[manifest.layers.length - 1]
  for (let i = manifest.layers.length - 1; i >= 0; i--) {
    const layer = manifest.layers[i]
    const texelToScreen = cam.scale / layerScale(manifest, layer)
    if (texelToScreen >= 1 - 1e-9) {
      chosen = layer
    } else {
      break
    }
  }
  return chosen
}

export interface TileSlot {
  col: number
  row: number
  /** 原图坐标空间的矩形。 */
  imageX: number
  imageY: number
  imageW: number
  imageH: number
  /** 屏幕坐标矩形（亚像素）。 */
  screenX: number
  screenY: number
  screenW: number
  screenH: number
}

/**
 * 计算某层级在当前视口内相交的全部瓦片槽位（含边缘不足 256 的瓦片）。
 * 槽位按行优先顺序返回，可作为解码队列的稳定顺序。
 */
export function visibleSlots(
  manifest: NormalizedManifest,
  layer: NormalizedLayer,
  cam: Camera
): TileSlot[] {
  // 宽高比例可能略有差异，x/y 分别按各自比例在层像素与原图像素间换算。
  const sx = layer.width / manifest.width
  const sy = layer.height / manifest.height

  const bounds = visibleImageBounds(cam)
  // 视口对应的层像素范围
  const lMinX = bounds.minX * sx
  const lMinY = bounds.minY * sy
  const lMaxX = bounds.maxX * sx
  const lMaxY = bounds.maxY * sy

  const c0 = Math.max(0, Math.floor(lMinX / layer.tileSize))
  const r0 = Math.max(0, Math.floor(lMinY / layer.tileSize))
  const c1 = Math.min(layer.cols - 1, Math.floor(lMaxX / layer.tileSize))
  const r1 = Math.min(layer.rows - 1, Math.floor(lMaxY / layer.tileSize))

  const slots: TileSlot[] = []
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const lx = col * layer.tileSize
      const ly = row * layer.tileSize
      const lw = Math.min(layer.tileSize, layer.width - lx)
      const lh = Math.min(layer.tileSize, layer.height - ly)
      const imageX = lx / sx
      const imageY = ly / sy
      const imageW = lw / sx
      const imageH = lh / sy
      slots.push({
        col,
        row,
        imageX,
        imageY,
        imageW,
        imageH,
        screenX: imageToScreenX(cam, imageX),
        screenY: imageToScreenY(cam, imageY),
        screenW: imageW * cam.scale,
        screenH: imageH * cam.scale
      })
    }
  }
  return slots
}

/** 原图矩形与 level 0 网格相交的瓦片坐标（导出用）。 */
export function baseTilesForRect(
  manifest: NormalizedManifest,
  rect: { x: number; y: number; width: number; height: number }
): Array<{ col: number; row: number }> {
  const base = manifest.layers.find((l) => l.level === 0) ?? manifest.layers[0]
  const ts = base.tileSize
  const c0 = Math.max(0, Math.floor(rect.x / ts))
  const r0 = Math.max(0, Math.floor(rect.y / ts))
  const c1 = Math.min(base.cols - 1, Math.floor((rect.x + rect.width) / ts))
  const r1 = Math.min(base.rows - 1, Math.floor((rect.y + rect.height) / ts))
  const out: Array<{ col: number; row: number }> = []
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      out.push({ col, row })
    }
  }
  return out
}
