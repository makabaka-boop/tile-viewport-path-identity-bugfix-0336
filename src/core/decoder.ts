/**
 * 瓦片解码器抽象。生产实现使用 createImageBitmap（浏览器）；
 * 测试注入「可延迟、可手动控制完成顺序」的实现。
 */
import type { DecodedBitmap } from './lru'

export interface TileRequest {
  key: string
  file: File
  /** manifest 声明的期望尺寸（边缘瓦片可不足 256）。 */
  expectedWidth: number
  expectedHeight: number
}

export interface TileDecoder {
  /**
   * 解码单个瓦片。实现应当：
   * - 返回的位图在不再使用时由缓存调用 close() 释放；
   * - 解码失败时 reject（调度器据此标记错误占位）。
   */
  decode(request: TileRequest): Promise<DecodedBitmap>
}

/** 浏览器位图解码器：本地 File -> createImageBitmap，全程不发起网络请求。 */
export class ImageBitmapTileDecoder implements TileDecoder {
  async decode(request: TileRequest): Promise<DecodedBitmap> {
    if (typeof createImageBitmap !== 'function') {
      throw new Error('当前环境不支持 createImageBitmap')
    }
    const bitmap = await createImageBitmap(request.file)
    // 以实际解码尺寸估算内存；与声明不符时以实际为准绘制（manifest 已校验尺寸合法性）。
    return {
      width: bitmap.width,
      height: bitmap.height,
      byteLength: bitmap.width * bitmap.height * 4,
      source: bitmap,
      close: () => bitmap.close()
    }
  }
}
