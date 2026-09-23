import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API runs separately in development; proxying keeps the app on one
    // origin so the httpOnly refresh cookie works without CORS exceptions.
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY ?? 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Keep the large, rarely-changing libraries in their own chunks so an
        // app deploy does not invalidate them.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('react-router')) return 'react'
          if (id.includes('/react-dom/') || id.includes('/react/')) return 'react'
          if (id.includes('@tanstack')) return 'query'
          if (id.includes('react-hook-form') || id.includes('@hookform') || id.includes('/zod/')) return 'forms'
          if (id.includes('recharts') || id.includes('d3-')) return 'charts'
          return undefined
        },
      },
    },
  },
})
