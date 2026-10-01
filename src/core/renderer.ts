/**
 * Canvas 2D 渲染器：输入 Workbench 计算出的槽位状态，输出一帧画面。
 *
 * - 槽位矩形已由 levels.visibleSlots 映射到屏幕（原图坐标的精确仿射映射）；
 * - 缺失 / 解码中 / 失败的瓦片绘制明确占位，绝不留白成背景色；
 * - 选择框（原图坐标）同样经相机变换绘制。
 */
import { imageToScreenX, imageToScreenY, type Camera } from './camera'
import type { DecodedBitmap } from './lru'
import type { SlotView } from './workbench'
import type { ImageRect } from './types'

export interface RenderInput {
  ctx: CanvasRenderingContext2D
  /** CSS 像素尺寸（位图实际尺寸 = cssSize × devicePixelRatio）。 */
  canvasWidth: number
  canvasHeight: number
  devicePixelRatio: number
  camera: Camera
  imageWidth: number
  imageHeight: number
  slots: SlotView[]
  bitmapFor(key: string): DecodedBitmap | null
  selection: ImageRect | null
  /** 框选进行中（虚线样式区分）。 */
  selectionDraft: boolean
}

export function renderFrame(input: RenderInput): void {
  const { ctx, canvasWidth: w, canvasHeight: h, camera: cam } = input

  // 统一在 CSS 像素空间绘制，由 transform 承担 DPR 缩放。
  ctx.setTransform(input.devicePixelRatio, 0, 0, input.devicePixelRatio, 0, 0)
  ctx.fillStyle = '#101216'
  ctx.fillRect(0, 0, w, h)
  drawBackdropPattern(ctx, w, h)

  // 图像底衬（保证即使没有任何瓦片也能看到图像范围）。
  const x0 = imageToScreenX(cam, 0)
  const y0 = imageToScreenY(cam, 0)
  const x1 = imageToScreenX(cam, input.imageWidth)
  const y1 = imageToScreenY(cam, input.imageHeight)
  ctx.fillStyle = '#1b1e25'
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0)

  for (const slot of input.slots) {
    drawSlot(ctx, slot, input.bitmapFor(slot.key))
  }

  // 原图边框。
  ctx.strokeStyle = '#3b82f6'
  ctx.lineWidth = 1
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1)

  if (input.selection) {
    drawSelection(ctx, cam, input.selection, input.selectionDraft)
  }
}

function drawBackdropPattern(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#15171c'
  const grid = 32
  for (let y = 0; y < h; y += grid) {
    for (let x = 0; x < w; x += grid) {
      if (((x / grid + y / grid) | 0) % 2 === 0) {
        ctx.fillRect(x, y, grid, grid)
      }
    }
  }
}

function drawSlot(ctx: CanvasRenderingContext2D, slot: SlotView, bitmap: DecodedBitmap | null): void {
  const { screenX: x, screenY: y, screenW: sw, screenH: sh } = slot

  if (slot.state === 'ready' && bitmap) {
    // 放大超过约 1% 时开启平滑，避免 256 瓦片近贴屏时抖动。
    ctx.imageSmoothingEnabled = sw > slot.imageW * 1.01
    ctx.imageSmoothingQuality = 'high'
    if (bitmap.source) {
      ctx.drawImage(bitmap.source, x, y, sw, sh)
    }
    return
  }

  if (slot.state === 'missing') {
    drawPlaceholder(ctx, x, y, sw, sh, {
      fill: '#2a2030',
      hatch: '#4b2f52',
      label: '缺失瓦片',
      sub: slot.file ?? '(manifest 未定义)',
      color: '#d8a7e6'
    })
    return
  }

  // loading（含 error）
  drawPlaceholder(
    ctx,
    x,
    y,
    sw,
    sh,
    slot.error
      ? { fill: '#3a2020', hatch: '#6e2f2f', label: '解码失败', sub: slot.file ?? '', color: '#f0a0a0' }
      : { fill: '#1d2430', hatch: '#2c3a4f', label: '解码中…', sub: slot.file ?? '', color: '#8fb4e6' }
  )
}

interface PlaceholderStyle {
  fill: string
  hatch: string
  label: string
  sub: string
  color: string
}

function drawPlaceholder(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  style: PlaceholderStyle
): void {
  if (w <= 0 || h <= 0) return
  ctx.fillStyle = style.fill
  ctx.fillRect(x, y, w, h)

  // 斜纹，占位在任意缩放下都醒目。
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  ctx.strokeStyle = style.hatch
  ctx.lineWidth = 1
  const gap = Math.max(8, Math.min(w, h) / 3)
  for (let d = -Math.max(w, h); d < Math.max(w, h) * 2; d += gap) {
    ctx.beginPath()
    ctx.moveTo(x + d, y)
    ctx.lineTo(x + d + Math.max(w, h), y + Math.max(w, h))
    ctx.stroke()
  }
  ctx.restore()

  ctx.strokeStyle = style.hatch
  ctx.lineWidth = 1
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)

  // 文字只在槽位足够大时绘制，避免缩小时噪点。
  if (w > 56 && h > 40) {
    ctx.fillStyle = style.color
    ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(style.label, x + w / 2, y + h / 2 - 7, w - 8)
    if (w > 110 && h > 64) {
      ctx.fillStyle = style.color
      ctx.globalAlpha = 0.75
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.fillText(style.sub, x + w / 2, y + h / 2 + 9, w - 8)
      ctx.globalAlpha = 1
    }
  }
}

function drawSelection(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  rect: ImageRect,
  draft: boolean
): void {
  const x = imageToScreenX(cam, rect.x)
  const y = imageToScreenY(cam, rect.y)
  const w = rect.width * cam.scale
  const h = rect.height * cam.scale

  ctx.fillStyle = 'rgba(59, 130, 246, 0.18)'
  ctx.fillRect(x, y, w, h)

  ctx.save()
  ctx.strokeStyle = '#60a5fa'
  ctx.lineWidth = 1.5
  if (draft) ctx.setLineDash([6, 4])
  ctx.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5)
  ctx.restore()

  // 四角手柄（屏幕固定 8px）。
  if (w > 12 && h > 12) {
    ctx.fillStyle = '#93c5fd'
    const hs = 4
    const corners: Array<[number, number]> = [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h]
    ]
    for (const [cx, cy] of corners) {
      ctx.fillRect(cx - hs, cy - hs, hs * 2, hs * 2)
    }
  }
}
