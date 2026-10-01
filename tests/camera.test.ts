import { describe, expect, it } from 'vitest'
import {
  clampCenter,
  createInitialCamera,
  panBy,
  screenToImageX,
  screenToImageY,
  zoomAt,
  zoomTo,
  type Camera
} from '../src/core/camera'

const W = 2048
const H = 1024
const VW = 800
const VH = 600

function makeCam(scale: number, cx = W / 2, cy = H / 2): Camera {
  return { centerX: cx, centerY: cy, scale, viewportWidth: VW, viewportHeight: VH }
}

describe('相机：屏幕 ↔ 原图映射', () => {
  it('初始视图完整包含图像并居中（含默认 24px 留白）', () => {
    const cam = createInitialCamera({
      viewportWidth: VW,
      viewportHeight: VH,
      imageWidth: W,
      imageHeight: H
    })
    const expected = Math.min((VW - 48) / W, (VH - 48) / H) // 宽度方向更紧
    expect(cam.scale).toBeCloseTo(expected, 10)
    expect(cam.centerX).toBeCloseTo(W / 2, 10)
    expect(cam.centerY).toBeCloseTo(H / 2, 10)
    // 完整包含：四周图像边界落在视口内
    expect(W * cam.scale).toBeLessThanOrEqual(VW - 48 + 1e-9)
    expect(H * cam.scale).toBeLessThanOrEqual(VH - 48 + 1e-9)
  })

  it('zoomAt 以鼠标为锚点：缩放前后锚点下的原图坐标一致', () => {
    const cam = makeCam(1)
    const ax = 612
    const ay = 137

    for (const factor of [1.5, 2, 0.25, 3.7, 0.1]) {
      const beforeX = screenToImageX(cam, ax)
      const beforeY = screenToImageY(cam, ay)
      const next = zoomAt(cam, ax, ay, factor, 0.01)
      const afterX = screenToImageX(next, ax)
      const afterY = screenToImageY(next, ay)
      expect(afterX).toBeCloseTo(beforeX, 6)
      expect(afterY).toBeCloseTo(beforeY, 6)
    }
  })

  it('连续多次以不同位置缩放，所有锚点均保持映射不变', () => {
    let cam = makeCam(0.8, 900, 400)
    const anchors: Array<[number, number, number]> = [
      [10, 10, 1.3],
      [790, 590, 0.7],
      [400, 300, 2.2],
      [250, 120, 0.4]
    ]
    for (const [ax, ay, f] of anchors) {
      const bx = screenToImageX(cam, ax)
      const by = screenToImageY(cam, ay)
      cam = zoomAt(cam, ax, ay, f, 0.01)
      expect(screenToImageX(cam, ax)).toBeCloseTo(bx, 6)
      expect(screenToImageY(cam, ay)).toBeCloseTo(by, 6)
    }
  })

  it('缩放极限时锚点也不漂移（夹到 max=64 后仍映射同一原图点）', () => {
    const cam = makeCam(1)
    const ax = 400
    const ay = 300
    const bx = screenToImageX(cam, ax)
    const by = screenToImageY(cam, ay)
    const next = zoomAt(cam, ax, ay, 100000, 0.01)
    expect(next.scale).toBe(64)
    expect(screenToImageX(next, ax)).toBeCloseTo(bx, 6)
    expect(screenToImageY(next, ay)).toBeCloseTo(by, 6)
  })

  it('zoomTo 以视口中心为锚点', () => {
    const cam = makeCam(1)
    const next = zoomTo(cam, 3, 0.01)
    expect(next.scale).toBeCloseTo(3, 10)
    expect(screenToImageX(next, VW / 2)).toBeCloseTo(screenToImageX(cam, VW / 2), 8)
    expect(screenToImageY(next, VH / 2)).toBeCloseTo(screenToImageY(cam, VH / 2), 8)
  })

  it('panBy 在原图空间产生与缩放无关的一致位移', () => {
    const cam = makeCam(2)
    const next = panBy(cam, 100, -40, W, H)
    // 屏幕右移 100 => 相机中心（原图坐标）减少 100/scale
    expect(next.centerX).toBeCloseTo(cam.centerX - 50, 8)
    expect(next.centerY).toBeCloseTo(cam.centerY + 20, 8)
  })

  it('平移夹取：图像不会完全漂出视口', () => {
    const cam = makeCam(1)
    const next = clampCenter({ ...cam, centerX: -9000, centerY: -9000 }, W, H)
    // 放大状态下允许看到边缘外，但图像至少保持贴边
    expect(next.centerX).toBeGreaterThanOrEqual(0)
    expect(next.centerY).toBeGreaterThanOrEqual(0)
  })

  it('缩小时图像小于视口则始终居中', () => {
    const cam = makeCam(0.1)
    const next = panBy(cam, 5000, 5000, W, H)
    expect(next.centerX).toBeCloseTo(W / 2, 8)
    expect(next.centerY).toBeCloseTo(H / 2, 8)
  })
})
