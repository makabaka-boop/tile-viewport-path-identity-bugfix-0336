# 多分辨率图像工作台（Vue 3 + TypeScript）

纯本地的多分辨率瓦片图像查看 / 框选导出工具。用户选择一份多分辨率
**manifest JSON** 及其引用的本地图片文件，所有解码都在浏览器内完成
（`createImageBitmap`），**文件绝不上传、不发起任何网络请求**。

## 功能

- **多分辨率金字塔**：level 0 为原图（最高分辨率），瓦片 256×256，
  右 / 下边缘允许不足；层级尺寸随 level 单调不增。
- **导入校验**：层级尺寸（正整数、level 0 与原图一致、单调不增、跳级告警）、
  瓦片坐标（网格范围内、层内唯一、边缘尺寸合法）、文件名（相对路径、全局唯一
  （折叠 `.` 片段后判定，`a/./b` 与 `a/b` 视为同一文件）、拒绝绝对路径与 `..`）。
  错误阻止导入；缺失瓦片 / 多余文件给出告警。
- **明确占位**：manifest 未定义、本地文件缺失、解码中、解码失败各有醒目占位
  （斜纹 + 文字 + 文件名），不会出现无法解释的空白。
- **原图坐标视口**：拖拽平移、滚轮 / 双击缩放，缩放以**鼠标位置为锚点**，
  视口始终精确映射到原图坐标（`screen = image * scale + offset`）。
- **受控解码**：解码并发最多 **4**；已解码位图存放于有**内存字节上限的 LRU**
  （默认 128 MiB，按 `w×h×4` 估算），淘汰 / 切换时调用 `ImageBitmap.close()` 释放。
- **迟到结果保护**：快速缩放后，旧层迟到的解码若已不属于当前视口，位图立即
  释放，绝不写入缓存或覆盖当前画面。
- **框选导出**：切换到「框选」工具拖拽选区，导出原图坐标 JSON
  （含相交的 level 0 瓦片坐标与文件名），可复制或下载。

## 快速开始（Docker，固定验收）

需要 Docker 24+（Compose v2）。依次执行：

```bash
docker compose config --quiet     # 1. 校验 compose 文件
docker compose build              # 2. 构建 web / verify 镜像
docker compose run --rm verify    # 3. 一次性测试：类型检查 + Vitest
```

`verify` 通过后启动 Web：

```bash
docker compose up web
# 打开 http://localhost:8080
```

## 本地开发

```bash
npm install
npm run dev        # Vite 开发服务器
npm test           # Vitest 一次性运行
npm run test:watch
npm run typecheck  # vue-tsc 严格类型检查
npm run build      # 类型检查 + 生产构建到 dist/
npm run preview
```

Node 20+。

## 使用方式

1. 点击「选择 manifest」，选择一个符合下述格式的 JSON 文件。
2. 点击「选择图片」（多选平铺文件）或「选择目录」（递归选择整个瓦片目录）。
   - 平铺选择时按 **basename** 匹配；跨层重名时请保留目录结构用「选择目录」。
3. 导入后面板显示校验错误 / 告警；缺失瓦片在画布上以占位呈现。
4. 默认平移工具：滚轮缩放（锚点为光标）、双击放大、`Shift+双击`缩小、
   中键或 `Shift+拖拽`临时平移；切到「框选」后拖拽选区。
5. 点击「导出 JSON」下载或「复制」。

### Manifest 格式

见 [`examples/manifest.example.json`](examples/manifest.example.json)：

```jsonc
{
  "name": "example-pyramid",
  "width": 512,          // 原图（level 0）宽
  "height": 512,
  "tileSize": 256,       // 可省略，默认 256；层级可覆盖
  "layers": [
    {
      "level": 0,        // 必须从 0 开始；尺寸随 level 单调不增
      "width": 512, "height": 512,
      "tiles": [
        // col/row 为瓦片网格坐标；file 为相对路径，全局唯一
        { "col": 0, "row": 0, "file": "tiles/l0/0_0.png" }
        // 边缘瓦片可显式给出不足 256 的 width/height
      ]
    },
    { "level": 1, "width": 256, "height": 256, "tiles": [] },
    { "level": 2, "width": 128, "height": 128, "tiles": [] }
  ]
}
```

### 导出 JSON 示例

```json
{
  "coordinateSpace": "image",
  "image": { "width": 512, "height": 512 },
  "selection": { "x": 100, "y": 120, "width": 260, "height": 180 },
  "level0Tiles": [
    { "level": 0, "col": 0, "row": 0, "file": "tiles/l0/0_0.png", "resolvedFile": "shoot/tiles/l0/0_0.png" }
  ]
}
```

`file` 是 manifest 中声明的路径；`resolvedFile` 是导入时实际解析到的本地文件标签
（目录选择时为其相对路径），用于解释画布真正显示的像素；缺失 / 歧义时为 `null`。
当同一引用后缀能匹配到多个本地文件（例如从同一父目录导入两套末尾路径相同的瓦片）
时，不按浏览器返回顺序静默选取，而是记为歧义并按缺失显示占位，两套文件均不产生
「多余文件」告警。

## 架构与关键设计

| 模块 | 职责 |
| --- | --- |
| `src/core/types.ts` | manifest / 瓦片 / 坐标等领域类型 |
| `src/core/manifest.ts` | 纯函数 manifest 校验、路径归一化、本地文件解析（不读内容） |
| `src/core/camera.ts` | 视口相机：屏幕↔原图映射、鼠标锚点缩放、平移夹取 |
| `src/core/levels.ts` | 层级选择（纹素→屏幕 ≥ 1 的最高分辨率层）、可见槽位迭代 |
| `src/core/lru.ts` | 字节上限 LRU，淘汰时 `close()` 释放位图 |
| `src/core/decoder.ts` | 解码器接口 + 浏览器 `createImageBitmap` 实现 |
| `src/core/scheduler.ts` | 4 并发 FIFO、世代（generation）防迟到覆盖、淘汰重入队 |
| `src/core/workbench.ts` | 整合：相机 + 层级 + 调度，框选与导出 |
| `src/core/renderer.ts` | Canvas 2D 渲染（DPR、占位、选区） |
| `src/App.vue` | 文件导入、指针 / 滚轮交互、面板与渲染循环 |

关键不变式：

- **缩放锚点**：`zoomAt` 后对同一屏幕点反算原图坐标，与缩放前严格相等
  （缩放过程不做破坏锚点的边界夹取，边界约束仅在平移时生效）。
- **世代**：`setVisible(generation, requests)` 世代单调递增；解码完成时若
  `job.generation < current` 且瓦片已不可见，位图 `close()` 丢弃。
- **LRU**：以 Map 插入序维护最近使用顺序；可见瓦片若被挤出会自动重新入队，
  渲染期间先显示占位。

## 测试

`tests/` 使用 Vitest（Node 环境，纯逻辑、无浏览器依赖）。
`tests/helpers.ts` 提供 **`DelayableDecoder`**：每个解码挂起直到测试显式
`resolveKey`，因此可以**任意打乱完成顺序**、观测并发峰值与位图关闭次数。

- `tests/camera.test.ts` — 缩放锚点不变性、连续缩放、平移夹取、居中适配。
- `tests/manifest.test.ts` — 尺寸 / 坐标 / 文件名唯一性 / 边缘瓦片 / 本地解析。
- `tests/lru.test.ts` — 字节上限、LRU 顺序、淘汰与 `close()`、清空释放。
- `tests/scheduler.test.ts` — 并发上限 4、乱序完成、旧层迟到丢弃且释放、
  过期世代忽略、可见条目淘汰后自动补位、失败标记、dispose 释放。
- `tests/workbench.test.ts` — 层级切换、槽位映射、缺失占位、框选导出原图坐标、
  level 0 瓦片列表、反向拖拽归一化。

运行：`npm test`（容器内即 `docker compose run --rm verify`）。
