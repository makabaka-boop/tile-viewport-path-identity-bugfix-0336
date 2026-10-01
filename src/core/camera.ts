/**
 * 视口相机：全部计算均在原图（level 0）坐标空间进行。
 *
 * scale 表示「1 个原图像素 = scale 个屏幕像素」：
 *   screen = image * scale + offset
 *   image  = (screen - offset) / scale
 *
 * 以鼠标为锚点缩放时，保证缩放前后光标下的原图坐标不变（屏幕位置不变）。
 */

export interface Camera {
  /** 视口中心对应的原图坐标（亚像素）。 */
  centerX: number
  centerY: number
  scale: number
  viewportWidth: number
  viewportHeight: number
}

export interface CameraInitOptions {
  viewportWidth: number
  viewportHeight: number
  imageWidth: number
  imageHeight: number
  /** 四周留白（屏幕像素）。 */
  padding?: number
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

export function minScaleFor(imageWidth: number, imageHeight: number, vw: number, vh: number): number {
  if (imageWidth <= 0 || imageHeight <= 0 || vw <= 0 || vh <= 0) return 1
  return Math.min(vw / imageWidth, vh / imageHeight)
}

/** 居中并完整显示图像的初始相机。 */
export function createInitialCamera(opts: CameraInitOptions): Camera {
  const { viewportWidth: vw, viewportHeight: vh, imageWidth, imageHeight } = opts
  const padding = opts.padding ?? 24
  const fit =
    imageWidth > 0 && imageHeight > 0 && vw > 0 && vh > 0
      ? Math.min((vw - padding * 2) / imageWidth, (vh - padding * 2) / imageHeight)
      : 1
  const scale = fit > 0 ? fit : 1
  const cam: Camera = {
    centerX: imageWidth / 2,
    centerY: imageHeight / 2,
    scale,
    viewportWidth: vw,
    viewportHeight: vh
  }
  return cam
}

export function screenToImageX(cam: Camera, screenX: number): number {
  return cam.centerX + (screenX - cam.viewportWidth / 2) / cam.scale
}

export function screenToImageY(cam: Camera, screenY: number): number {
  return cam.centerY + (screenY - cam.viewportHeight / 2) / cam.scale
}

export function imageToScreenX(cam: Camera, imageX: number): number {
  return cam.viewportWidth / 2 + (imageX - cam.centerX) * cam.scale
}

export function imageToScreenY(cam: Camera, imageY: number): number {
  return cam.viewportHeight / 2 + (imageY - cam.centerY) * cam.scale
}

/** 限制平移范围：图像始终至少有一条边贴在视口内，不会漂到画面外。 */
export function clampCenter(cam: Camera, imageWidth: number, imageHeight: number): Camera {
  const halfW = cam.viewportWidth / 2 / cam.scale
  const halfH = cam.viewportHeight / 2 / cam.scale
  // 图像小于视口时保持居中；否则可在边缘内平移。
  const minX = Math.min(imageWidth / 2, halfW)
  const maxX = Math.max(imageWidth / 2, imageWidth - halfW)
  const minY = Math.min(imageHeight / 2, halfH)
  const maxY = Math.max(imageHeight / 2, imageHeight - halfH)
  return {
    ...cam,
    centerX: clamp(cam.centerX, minX, maxX),
    centerY: clamp(cam.centerY, minY, maxY)
  }
}

export function clampScale(scale: number, minScale: number): number {
  const max = 64 // 原图的 64 倍，足够检查像素
  return clamp(scale, minScale, max)
}

/**
 * 以屏幕点 (anchorX, anchorY) 为锚点缩放。锚点处的原图坐标保持不变。
 *
 * 注意：缩放过程中**不**对 center 做边界夹取——任何夹取都会移动锚点投影、
 * 破坏「光标下原图坐标不变」这一核心约定。边界约束只在平移（panBy）时生效。
 *
 * @param minScale 允许的最小比例（由工作台结合视口与最粗金字塔层算出）。
 */
export function zoomAt(
  cam: Camera,
  anchorX: number,
  anchorY: number,
  factor: number,
  minScale: number
): Camera {
  const target = clampScale(cam.scale * factor, minScale)
  // 锚点原图坐标：image = center + (anchor - viewport/2) / scale
  const imageX = screenToImageX(cam, anchorX)
  const imageY = screenToImageY(cam, anchorY)
  // 缩放后令同一 (imageX,imageY) 仍投影到 (anchorX,anchorY)：
  // center' = image - (anchor - viewport/2) / target
  return {
    ...cam,
    scale: target,
    centerX: imageX - (anchorX - cam.viewportWidth / 2) / target,
    centerY: imageY - (anchorY - cam.viewportHeight / 2) / target
  }
}

/** 以视口中心为锚点缩放到绝对比例。 */
export function zoomTo(cam: Camera, scale: number, minScale: number): Camera {
  return zoomAt(cam, cam.viewportWidth / 2, cam.viewportHeight / 2, scale / cam.scale, minScale)
}

/** 拖拽平移：delta 为屏幕像素位移。 */
export function panBy(cam: Camera, deltaX: number, deltaY: number, imageWidth: number, imageHeight: number): Camera {
  const next: Camera = {
    ...cam,
    centerX: cam.centerX - deltaX / cam.scale,
    centerY: cam.centerY - deltaY / cam.scale
  }
  return clampCenter(next, imageWidth, imageHeight)
}

export interface VisibleImageBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function visibleImageBounds(cam: Camera): VisibleImageBounds {
  return {
    minX: screenToImageX(cam, 0),
    minY: screenToImageY(cam, 0),
    maxX: screenToImageX(cam, cam.viewportWidth),
    maxY: screenToImageY(cam, cam.viewportHeight)
  }
}
