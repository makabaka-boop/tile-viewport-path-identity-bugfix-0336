/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  // vitest 通过 vite 配置读取该字段（类型由 vitest/config 的三斜线引用补充）。
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10000
  }
})
