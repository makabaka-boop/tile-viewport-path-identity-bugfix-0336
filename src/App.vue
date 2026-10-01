<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue'
import { parseManifest, resolveFiles, type ResolvedFiles } from './core/manifest'
import type { Issue, NormalizedManifest } from './core/types'
import { ImageBitmapTileDecoder } from './core/decoder'
import { TileScheduler } from './core/scheduler'
import { Workbench, type ExportResult, type Tool } from './core/workbench'
import { renderFrame } from './core/renderer'

const CACHE_MAX_BYTES = 128 * 1024 * 1024

// ---------- 导入状态 ----------
const manifestFile = shallowRef<File | null>(null)
const imageFiles = shallowRef<File[]>([])
const manifestInput = ref<HTMLInputElement | null>(null)
const imagesInput = ref<HTMLInputElement | null>(null)
const dirInput = ref<HTMLInputElement | null>(null)

const loadIssues = ref<Issue[]>([])
const resolved = shallowRef<ResolvedFiles | null>(null)
const workbench = shallowRef<Workbench | null>(null)

const loaded = computed(() => workbench.value !== null)
const imageName = computed(() => workbench.value?.manifest.name ?? '')

const errors = computed(() => loadIssues.value.filter((i) => i.severity === 'error'))

async function onManifestPicked(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement
  manifestFile.value = input.files?.[0] ?? null
  await tryImport()
}

function onImagesPicked(ev: Event): void {
  const input = ev.target as HTMLInputElement
  imageFiles.value = input.files ? Array.from(input.files) : []
  void tryImport()
}

async function tryImport(): Promise<void> {
  loadIssues.value = []
  const file = manifestFile.value
  if (!file) return

  let json: unknown
  try {
    json = JSON.parse(await file.text())
  } catch (err) {
    loadIssues.value = [
      { severity: 'error', code: 'manifest.parse', message: `manifest JSON 解析失败：${(err as Error).message}` }
    ]
    destroyWorkbench()
    return
  }

  const result = parseManifest(json)
  loadIssues.value = result.issues
  if (!result.manifest) {
    destroyWorkbench()
    return
  }
  const manifest: NormalizedManifest = result.manifest

  const files = imageFiles.value
  const res = resolveFiles(manifest, files)
  resolved.value = res

  const issues = [...loadIssues.value]
  if (res.missing.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'files.missing',
      message: `${res.missing.length} 个瓦片文件缺失，将显示占位：${res.missing.slice(0, 4).join(', ')}${res.missing.length > 4 ? ' …' : ''}`
    })
  }
  if (res.ambiguous.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'files.ambiguous',
      message: `${res.ambiguous.length} 个引用存在同名文件，按缺失处理：${res.ambiguous.slice(0, 4).join(', ')}`
    })
  }
  if (res.unused.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'files.unused',
      message: `${res.unused.length} 个所选文件未被 manifest 引用`
    })
  }
  loadIssues.value = issues

  openWorkbench(manifest, res)
}

let scheduler: TileScheduler | null = null

function openWorkbench(manifest: NormalizedManifest, res: ResolvedFiles): void {
  destroyWorkbench()
  scheduler = new TileScheduler({
    decoder: new ImageBitmapTileDecoder(),
    cacheMaxBytes: CACHE_MAX_BYTES,
    maxConcurrency: 4,
    onChange: () => {
      if (wb) wb.markDirty()
    }
  })
  const wb = new Workbench({ manifest, files: res.byPath, scheduler })
  workbench.value = wb
  wb.setViewport(canvasCssSize().w, canvasCssSize().h)
  wb.activate()
}

function destroyWorkbench(): void {
  workbench.value?.dispose()
  scheduler?.dispose()
  scheduler = null
  workbench.value = null
  selectionJson.value = null
}

// ---------- 画布与渲染循环 ----------
const canvas = ref<HTMLCanvasElement | null>(null)
const wrap = ref<HTMLDivElement | null>(null)
let rafId = 0
let resizeObs: ResizeObserver | null = null

function canvasCssSize(): { w: number; h: number } {
  return {
    w: wrap.value?.clientWidth ?? 1,
    h: wrap.value?.clientHeight ?? 1
  }
}

const stats = reactive({ queued: 0, inflight: 0, cached: 0, cacheBytes: 0, errors: 0 })
const cursor = reactive({ x: 0, y: 0, inside: false })
const zoomPct = ref(0)
const activeLevel = ref(0)
const tool = ref<Tool>('pan')
const selectionJson = shallowRef<ExportResult | null>(null)

const frame = (): void => {
  const wb = workbench.value
  const cv = canvas.value
  if (wb && cv) {
    const ctx = cv.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    const { w, h } = canvasCssSize()
    const bw = Math.max(1, Math.round(w * dpr))
    const bh = Math.max(1, Math.round(h * dpr))
    if (cv.width !== bw || cv.height !== bh) {
      cv.width = bw
      cv.height = bh
    }
    if (wb.consumeDirty() || statsChanged(wb)) {
      const slots = wb.computeSlots()
      renderFrame({
        ctx: ctx!,
        canvasWidth: w,
        canvasHeight: h,
        devicePixelRatio: dpr,
        camera: wb.camera,
        imageWidth: wb.imageWidth,
        imageHeight: wb.imageHeight,
        slots,
        bitmapFor: (key) => wb.scheduler.getBitmap(key) ?? null,
        selection: wb.effectiveSelection(),
        selectionDraft: wb.selecting !== null
      })
      activeLevel.value = slots[0]?.level ?? 0
    }
    syncStats(wb)
    zoomPct.value = Math.round(wb.camera.scale * 100)
  }
  rafId = requestAnimationFrame(frame)
}

let lastStatsKey = ''
function statsChanged(wb: Workbench): boolean {
  const s = wb.scheduler.stats
  const key = `${s.queued}|${s.inflight}|${s.cached}|${s.cacheBytes}|${s.errors}`
  return key !== lastStatsKey
}

function syncStats(wb: Workbench): void {
  const s = wb.scheduler.stats
  stats.queued = s.queued
  stats.inflight = s.inflight
  stats.cached = s.cached
  stats.cacheBytes = s.cacheBytes
  stats.errors = s.errors
  lastStatsKey = `${s.queued}|${s.inflight}|${s.cached}|${s.cacheBytes}|${s.errors}`
}

let wheelHandler: ((ev: WheelEvent) => void) | null = null

onMounted(() => {
  rafId = requestAnimationFrame(frame)
  if (wrap.value) {
    resizeObs = new ResizeObserver(() => {
      const wb = workbench.value
      if (!wb) return
      const { w, h } = canvasCssSize()
      wb.setViewport(w, h)
    })
    resizeObs.observe(wrap.value)
  }
  // 滚轮必须在非被动监听中才能 preventDefault（阻止页面滚动）。
  if (canvas.value) {
    wheelHandler = (ev: WheelEvent) => onWheel(ev)
    canvas.value.addEventListener('wheel', wheelHandler, { passive: false })
  }
})

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  resizeObs?.disconnect()
  if (canvas.value && wheelHandler) {
    canvas.value.removeEventListener('wheel', wheelHandler)
  }
  destroyWorkbench()
})

// ---------- 指针交互 ----------
function eventPoint(ev: MouseEvent | PointerEvent): { x: number; y: number } {
  const rect = canvas.value!.getBoundingClientRect()
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top }
}

function onPointerDown(ev: PointerEvent): void {
  const wb = workbench.value
  if (!wb) return
  ;(ev.target as Element).setPointerCapture?.(ev.pointerId)
  const { x, y } = eventPoint(ev)
  wb.pointerDown(x, y, ev.button, ev.shiftKey)
}

function onPointerMove(ev: PointerEvent): void {
  const wb = workbench.value
  if (!wb) return
  const { x, y } = eventPoint(ev)
  cursor.inside = true
  const p = wb.toImagePoint(x, y)
  cursor.x = p.x
  cursor.y = p.y
  wb.pointerMove(x, y)
}

function onPointerUp(): void {
  const wb = workbench.value
  if (!wb) return
  wb.pointerUp()
  // 框选结束后若产生新选择，更新导出预览。
  refreshExport()
}

function onPointerLeave(): void {
  cursor.inside = false
}

function onWheel(ev: WheelEvent): void {
  const wb = workbench.value
  if (!wb) return
  ev.preventDefault()
  const { x, y } = eventPoint(ev)
  wb.handleWheel(x, y, ev.deltaY, ev.deltaMode)
}

function onDblClick(ev: MouseEvent): void {
  const wb = workbench.value
  if (!wb) return
  const { x, y } = eventPoint(ev)
  wb.zoomAtPoint(x, y, ev.shiftKey ? 0.5 : 2)
}

function onContext(ev: Event): void {
  // 平移时避免右键菜单干扰（中键平移不受影响）。
  if (workbench.value?.tool === 'pan') ev.preventDefault()
}

// ---------- 工具按钮 ----------
function setTool(t: Tool): void {
  tool.value = t
  workbench.value?.setTool(t)
}

function resetView(): void {
  workbench.value?.resetView()
}

function zoom(factor: number): void {
  const wb = workbench.value
  if (!wb) return
  wb.zoomAtPoint(wb.camera.viewportWidth / 2, wb.camera.viewportHeight / 2, factor)
}

function refreshExport(): void {
  selectionJson.value = workbench.value?.exportSelection() ?? null
}

function clearSelection(): void {
  workbench.value?.clearSelection()
  selectionJson.value = null
}

function downloadJson(): void {
  const result = selectionJson.value
  if (!result) return
  const blob = new Blob([result.json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'selection.json'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function copyJson(): Promise<void> {
  if (!selectionJson.value) return
  await navigator.clipboard.writeText(selectionJson.value.json)
}

function pickImagesLabel(): string {
  const n = imageFiles.value.length
  if (manifestFile.value && n === 0) return '尚未选择图片文件'
  if (n === 0) return '选择瓦片图片（可多选 / 选目录）'
  return `已选择 ${n} 个本地文件`
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <div class="app">
    <div class="toolbar">
      <div class="group">
        <button @click="manifestInput?.click()">选择 manifest</button>
        <span class="file-label">{{ manifestFile?.name ?? '未选择 manifest JSON' }}</span>
        <input
          ref="manifestInput"
          type="file"
          accept="application/json,.json"
          @change="onManifestPicked"
        />
      </div>

      <div class="group">
        <button @click="imagesInput?.click()">选择图片</button>
        <button @click="dirInput?.click()" title="递归选择整个瓦片目录">选择目录</button>
        <span class="file-label">{{ pickImagesLabel() }}</span>
        <input
          ref="imagesInput"
          type="file"
          multiple
          accept="image/*"
          @change="onImagesPicked"
        />
        <input
          ref="dirInput"
          type="file"
          multiple
          webkitdirectory
          @change="onImagesPicked"
        />
      </div>

      <div class="group" v-if="loaded">
        <button :class="{ active: tool === 'pan' }" @click="setTool('pan')">平移</button>
        <button :class="{ active: tool === 'select' }" @click="setTool('select')">框选</button>
      </div>

      <div class="group" v-if="loaded">
        <button @click="zoom(1 / 1.25)" title="缩小">−</button>
        <span class="pill">{{ zoomPct }}%</span>
        <button @click="zoom(1.25)" title="放大">＋</button>
        <button @click="resetView()">适应窗口</button>
      </div>

      <div class="group" v-if="loaded && tool === 'select'">
        <button :disabled="!selectionJson" @click="downloadJson">导出 JSON</button>
        <button :disabled="!selectionJson" @click="copyJson">复制</button>
        <button :disabled="!selectionJson" @click="clearSelection">清除选择</button>
      </div>
    </div>

    <div class="main">
      <div ref="wrap" class="canvas-wrap">
        <canvas
          ref="canvas"
          class="viewport"
          :class="{ panning: workbench?.panning, select: tool === 'select' }"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
          @pointerleave="onPointerLeave"
          @dblclick="onDblClick"
          @contextmenu="onContext"
        ></canvas>
      </div>

      <div class="empty" v-if="!loaded">
        <div class="card">
          <h1>多分辨率图像工作台</h1>
          <p>选择一份多分辨率 <b>manifest.json</b> 与其引用的本地瓦片图片。</p>
          <p>文件仅在本机浏览器内解码（createImageBitmap），<b>不会上传</b>。</p>
          <p class="hint">每层瓦片 256×256，边缘允许不足；缺失瓦片将显示明确占位。</p>
          <div class="actions">
            <button class="big-btn" @click="manifestInput?.click()">1. 选择 manifest</button>
            <button class="big-btn" @click="imagesInput?.click()">2. 选择图片</button>
            <button class="big-btn" @click="dirInput?.click()">或选择目录</button>
          </div>
          <p class="hint" v-if="errors.length">共 {{ errors.length }} 个校验错误，请见右上角面板。</p>
        </div>
      </div>

      <aside class="sidebar" v-if="loaded || errors.length">
        <h3 v-if="loaded">{{ imageName }} · {{ workbench?.manifest.layers.length }} 层</h3>

        <template v-if="loaded">
          <div class="kv"><span>当前层级</span><b>L{{ activeLevel }}</b></div>
          <div class="kv"><span>原图尺寸</span><b>{{ workbench?.imageWidth }}×{{ workbench?.imageHeight }}</b></div>
          <div class="kv">
            <span>光标（原图坐标）</span>
            <b v-if="cursor.inside">{{ cursor.x.toFixed(1) }}, {{ cursor.y.toFixed(1) }}</b>
            <b v-else>—</b>
          </div>
          <div class="kv"><span>解码 队列 / 在途</span><b>{{ stats.queued }} / {{ stats.inflight }}（上限 4）</b></div>
          <div class="kv"><span>缓存位图 / 内存</span><b>{{ stats.cached }} · {{ formatBytes(stats.cacheBytes) }} / 128 MB</b></div>
          <div class="kv" v-if="resolved?.missing.length">
            <span>缺失瓦片</span><b>{{ resolved.missing.length }}</b>
          </div>
        </template>

        <div class="issues" v-if="loadIssues.length">
          <div
            v-for="(issue, i) in loadIssues"
            :key="i"
            class="issue"
            :class="issue.severity"
          >
            {{ issue.message }}
          </div>
        </div>

        <template v-if="selectionJson">
          <h3 style="margin-top: 12px">导出（原图坐标 JSON）</h3>
          <div class="kv"><span>x, y</span><b>{{ selectionJson.rect.x.toFixed(2) }}, {{ selectionJson.rect.y.toFixed(2) }}</b></div>
          <div class="kv"><span>width × height</span><b>{{ selectionJson.rect.width.toFixed(2) }} × {{ selectionJson.rect.height.toFixed(2) }}</b></div>
          <pre class="export-json">{{ selectionJson.json }}</pre>
        </template>
      </aside>
    </div>

    <div class="statusbar">
      <span class="pill">{{ loaded ? `L${activeLevel}` : '未加载' }}</span>
      <span v-if="loaded">滚轮以光标为锚点缩放 · 双击放大 · Shift+双击缩小 · Shift+拖拽临时平移</span>
      <span class="spacer"></span>
      <span v-if="loaded">缓存 {{ formatBytes(stats.cacheBytes) }} / 128 MB · 在途 {{ stats.inflight }} · 队列 {{ stats.queued }}</span>
    </div>
  </div>
</template>
