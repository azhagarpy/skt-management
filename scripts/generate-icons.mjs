import { deflateSync, inflateSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Generates the site and PWA icons from the SK Transport logo.
 *
 * A tiny hand-rolled PNG decoder and encoder keeps this dependency-free: the
 * logo is trimmed to its artwork, scaled down with area averaging, and set on
 * a white tile. Run with `npm run icons` after replacing the logo file.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOGO = join(ROOT, 'scripts', 'assets', 'sk-transport-logo.png')
const OUTPUT_DIR = join(ROOT, 'public', 'icons')

const TILE = [255, 255, 255]

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

/** Decodes an 8-bit, non-interlaced RGB or RGBA PNG into RGBA pixels. */
function decodePng(file) {
  const data = readFileSync(file)
  let offset = 8
  let header = null
  const idat = []
  while (offset < data.length) {
    const length = data.readUInt32BE(offset)
    const type = data.toString('ascii', offset + 4, offset + 8)
    const body = data.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colour: body[9], interlace: body[12] }
    } else if (type === 'IDAT') {
      idat.push(body)
    }
    offset += 12 + length
  }
  if (!header || header.depth !== 8 || ![2, 6].includes(header.colour) || header.interlace !== 0) {
    throw new Error(`${file} must be an 8-bit, non-interlaced RGB or RGBA PNG`)
  }

  const { width, height } = header
  const channels = header.colour === 6 ? 4 : 3
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(idat))
  const rows = Buffer.alloc(stride * height)

  // Undo each scanline's filter (PNG specification, section 9).
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = y * stride
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? rows[out + x - channels] : 0
      const up = y > 0 ? rows[out - stride + x] : 0
      const upLeft = y > 0 && x >= channels ? rows[out - stride + x - channels] : 0
      let predictor = 0
      if (filter === 1) predictor = left
      else if (filter === 2) predictor = up
      else if (filter === 3) predictor = (left + up) >> 1
      else if (filter === 4) {
        const estimate = left + up - upLeft
        const toLeft = Math.abs(estimate - left)
        const toUp = Math.abs(estimate - up)
        const toUpLeft = Math.abs(estimate - upLeft)
        predictor = toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft
      }
      rows[out + x] = (line[x] + predictor) & 0xff
    }
  }

  const pixels = Buffer.alloc(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 4] = rows[index * channels]
    pixels[index * 4 + 1] = rows[index * channels + 1]
    pixels[index * 4 + 2] = rows[index * channels + 2]
    pixels[index * 4 + 3] = channels === 4 ? rows[index * channels + 3] : 255
  }
  return { width, height, pixels }
}

/** The box around the logo's artwork: every pixel that is not (nearly) transparent or white. */
function artworkBounds({ width, height, pixels }) {
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4
      const white = pixels[index] > 245 && pixels[index + 1] > 245 && pixels[index + 2] > 245
      if (pixels[index + 3] < 16 || white) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  if (right < 0) throw new Error('The logo has no visible artwork')
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
}

/**
 * Scales a region of the image to `targetWidth` x `targetHeight` by averaging
 * every source pixel that falls in each target pixel, which stays sharp and
 * free of aliasing even shrinking a large logo to 32px. Returns premultiplied
 * RGBA as floats in 0..1.
 */
function resample({ width, pixels }, region, targetWidth, targetHeight) {
  const scaleX = region.width / targetWidth
  const scaleY = region.height / targetHeight

  // Horizontal pass: each source row of the region, down to targetWidth columns.
  const across = new Float64Array(region.height * targetWidth * 4)
  for (let y = 0; y < region.height; y += 1) {
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const start = region.x + tx * scaleX
      const end = start + scaleX
      const sums = [0, 0, 0, 0]
      // Clamped: rounding can put `end` a hair past the region's edge.
      for (let sx = Math.floor(start); sx < Math.min(Math.ceil(end), region.x + region.width); sx += 1) {
        const weight = Math.min(end, sx + 1) - Math.max(start, sx)
        const index = ((region.y + y) * width + sx) * 4
        const alpha = pixels[index + 3] / 255
        sums[0] += (pixels[index] / 255) * alpha * weight
        sums[1] += (pixels[index + 1] / 255) * alpha * weight
        sums[2] += (pixels[index + 2] / 255) * alpha * weight
        sums[3] += alpha * weight
      }
      for (let channel = 0; channel < 4; channel += 1) across[(y * targetWidth + tx) * 4 + channel] = sums[channel] / scaleX
    }
  }

  // Vertical pass: the columns down to targetHeight rows.
  const out = new Float64Array(targetWidth * targetHeight * 4)
  for (let ty = 0; ty < targetHeight; ty += 1) {
    const start = ty * scaleY
    const end = start + scaleY
    for (let tx = 0; tx < targetWidth; tx += 1) {
      for (let channel = 0; channel < 4; channel += 1) {
        let sum = 0
        for (let sy = Math.floor(start); sy < Math.min(Math.ceil(end), region.height); sy += 1) {
          const weight = Math.min(end, sy + 1) - Math.max(start, sy)
          sum += across[(sy * targetWidth + tx) * 4 + channel] * weight
        }
        out[(ty * targetWidth + tx) * 4 + channel] = sum / scaleY
      }
    }
  }
  return out
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
 * Draws one icon: the logo centred on a white tile.
 *
 *  - `tile: 'rounded'` leaves the corners transparent, for browser tabs and
 *    desktop installs; `'square'` fills the whole icon, for platforms that cut
 *    their own shape (iOS, and Android's maskable icons).
 *  - `logoWidth` is the logo's width as a share of the icon. A maskable icon
 *    keeps the whole logo inside the safe zone, the central circle 80% across.
 */
function renderIcon(logo, artwork, size, { tile, logoWidth }) {
  const pixels = Buffer.alloc(size * size * 4)
  const centre = size / 2
  const tileHalf = tile === 'rounded' ? size * 0.46 : size * 0.5
  const radius = tile === 'rounded' ? size * 0.22 : 0

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = roundedRectDistance(x + 0.5 - centre, y + 0.5 - centre, tileHalf, tileHalf, radius)
      // 1px of feathering keeps the edge smooth without a rasteriser.
      const coverage = Math.min(Math.max(0.5 - distance, 0), 1)
      const index = (y * size + x) * 4
      pixels[index] = TILE[0]
      pixels[index + 1] = TILE[1]
      pixels[index + 2] = TILE[2]
      pixels[index + 3] = Math.round(255 * coverage)
    }
  }

  const width = Math.round(size * logoWidth)
  const height = Math.round((width * artwork.height) / artwork.width)
  const scaled = resample(logo, artwork, width, height)
  const left = Math.round((size - width) / 2)
  const top = Math.round((size - height) / 2)

  // The logo over the tile: premultiplied colour plus the tile behind what it leaves uncovered.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * 4
      const index = ((top + y) * size + left + x) * 4
      const alpha = scaled[from + 3]
      for (let channel = 0; channel < 3; channel += 1) {
        const value = scaled[from + channel] * 255 + pixels[index + channel] * (1 - alpha)
        pixels[index + channel] = Math.max(0, Math.min(255, Math.round(value)))
      }
    }
  }

  return encodePng(size, size, pixels)
}

const logo = decodePng(LOGO)
const artwork = artworkBounds(logo)

mkdirSync(OUTPUT_DIR, { recursive: true })

const outputs = [
  { file: 'icon-192.png', size: 192, tile: 'rounded', logoWidth: 0.8 },
  { file: 'icon-512.png', size: 512, tile: 'rounded', logoWidth: 0.8 },
  // Width 0.62 puts the logo's corners just inside the safe zone's circle.
  { file: 'icon-maskable-512.png', size: 512, tile: 'square', logoWidth: 0.62 },
  { file: 'apple-touch-icon.png', size: 180, tile: 'square', logoWidth: 0.8 },
  // As large as the tile allows, so the SK still reads at tab size.
  { file: 'favicon-32.png', size: 32, tile: 'rounded', logoWidth: 0.9 },
]

for (const output of outputs) {
  const png = renderIcon(logo, artwork, output.size, output)
  writeFileSync(join(OUTPUT_DIR, output.file), png)
  process.stdout.write(`Wrote ${output.file} (${output.size}x${output.size}, ${png.length} bytes)\n`)
}
