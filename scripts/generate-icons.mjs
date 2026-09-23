import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Generates the PWA icons.
 *
 * A tiny hand-rolled PNG encoder keeps this dependency-free: the icons are flat
 * shapes on a solid ground, which is all the encoder needs to support. Run with
 * `npm run icons` after changing the brand colours.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT_DIR = join(ROOT, 'public', 'icons')

const BACKGROUND = [46, 42, 107] // #2e2a6b
const FOREGROUND = [244, 249, 247] // #f4f9f7
const ACCENT = [148, 142, 240] // #948ef0

function crc32(buffer) {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index]
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

function encodePng(width, height, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // truecolour with alpha
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  // Each scanline is prefixed with a filter byte; filter 0 (none) keeps it simple.
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function blend(target, index, colour, alpha) {
  for (let channel = 0; channel < 3; channel += 1) {
    const existing = target[index + channel]
    target[index + channel] = Math.round(existing * (1 - alpha) + colour[channel] * alpha)
  }
  target[index + 3] = 255
}

/** Signed distance to a rounded rectangle, used for antialiased edges. */
function roundedRectDistance(x, y, halfWidth, halfHeight, radius) {
  const dx = Math.abs(x) - (halfWidth - radius)
  const dy = Math.abs(y) - (halfHeight - radius)
  const outsideX = Math.max(dx, 0)
  const outsideY = Math.max(dy, 0)
  return Math.sqrt(outsideX * outsideX + outsideY * outsideY) + Math.min(Math.max(dx, dy), 0) - radius
}

/**
 * Draws the mark: a rounded tile with an ascending bar chart, which reads as
 * "people operations" at 16px as well as 512px.
 */
function renderIcon(size, { maskable }) {
  const pixels = Buffer.alloc(size * size * 4)
  const centre = size / 2
  // A maskable icon must keep its content inside the safe zone.
  const tileHalf = maskable ? size * 0.5 : size * 0.46
  const radius = maskable ? tileHalf : size * 0.22
  const contentScale = maskable ? 0.72 : 1

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4
      const px = x + 0.5 - centre
      const py = y + 0.5 - centre

      const distance = roundedRectDistance(px, py, tileHalf, tileHalf, radius)
      // 1px of feathering keeps the edge smooth without a rasteriser.
      const coverage = Math.min(Math.max(0.5 - distance, 0), 1)

      if (coverage <= 0) {
        pixels[index] = 0
        pixels[index + 1] = 0
        pixels[index + 2] = 0
        pixels[index + 3] = 0
        continue
      }

      pixels[index] = BACKGROUND[0]
      pixels[index + 1] = BACKGROUND[1]
      pixels[index + 2] = BACKGROUND[2]
      pixels[index + 3] = Math.round(255 * coverage)
    }
  }

  // Three ascending bars, the tallest in the accent colour.
  const bars = [
    { offset: -0.26, height: 0.26, colour: FOREGROUND },
    { offset: 0.0, height: 0.4, colour: FOREGROUND },
    { offset: 0.26, height: 0.54, colour: ACCENT },
  ]
  const barWidth = size * 0.13 * contentScale
  const baseline = size * 0.28 * contentScale

  for (const bar of bars) {
    const barCentreX = bar.offset * size * contentScale
    const barHeight = bar.height * size * contentScale
    const barTop = baseline - barHeight
    const barCentreY = (baseline + barTop) / 2
    const halfHeight = barHeight / 2
    const barRadius = barWidth / 2

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const index = (y * size + x) * 4
        if (pixels[index + 3] === 0) continue

        const px = x + 0.5 - centre - barCentreX
        const py = y + 0.5 - centre - barCentreY
        const distance = roundedRectDistance(px, py, barWidth / 2, halfHeight, barRadius)
        const coverage = Math.min(Math.max(0.5 - distance, 0), 1)
        if (coverage > 0) blend(pixels, index, bar.colour, coverage)
      }
    }
  }

  return encodePng(size, size, pixels)
}

mkdirSync(OUTPUT_DIR, { recursive: true })

const outputs = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', size: 180, maskable: false },
  { file: 'favicon-32.png', size: 32, maskable: false },
]

for (const output of outputs) {
  const png = renderIcon(output.size, { maskable: output.maskable })
  writeFileSync(join(OUTPUT_DIR, output.file), png)
  process.stdout.write(`Wrote ${output.file} (${output.size}x${output.size}, ${png.length} bytes)\n`)
}
