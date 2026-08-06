import type { MentorCapturePayload } from '@shared/preload-api'
import { recognizeScreenText } from './ocr'
import {
  stitchOcrFrames,
  type OcrCaptureFrame,
  type OcrStitchStep
} from './ocr-stitch'

export interface ScrollCaptureFrame {
  imageBase64: string
  width: number
  height: number
  contentX: number
  contentWidth: number
  addedPixels: number
  continuityConfirmed: boolean
  similarity: number
  capturedAt: number
  sample: VisualSample
}

export interface ScrollCaptureAppendResult {
  frames: ScrollCaptureFrame[]
  accepted: boolean
  warnings: string[]
  lastStep: OcrStitchStep | null
}

export interface LongCaptureRecognition {
  text: string
  confidence: number
  inputQuality: 'high' | 'medium' | 'low'
  warnings: string[]
  tileCount: number
  totalHeight: number
  engine: 'apple-vision' | 'mixed'
}

interface VisualSample {
  width: number
  height: number
  edges: Uint8Array
}

interface ShiftMatch {
  shiftPixels: number
  similarity: number
  contentX: number
  contentWidth: number
}

interface CapturePiece {
  image: ImageBitmap
  sourceX: number
  sourceY: number
  width: number
  height: number
  destinationY: number
}

interface CaptureTile {
  imageBase64: string
  width: number
  height: number
}

const SAMPLE_WIDTH = 112
const MAX_SAMPLE_HEIGHT = 180
const MIN_VISUAL_SIMILARITY = 0.52
const MIN_ACCEPTED_SHIFT_RATIO = 0.055
const MAX_ACCEPTED_FRAMES = 72
const TILE_HEIGHT = 3_200
const TILE_OVERLAP = 220
const MAX_COMPOSED_HEIGHT = 48_000

function imageDataUrl(imageBase64: string): string {
  return imageBase64.startsWith('data:')
    ? imageBase64
    : `data:image/png;base64,${imageBase64}`
}

async function decodeImage(imageBase64: string): Promise<ImageBitmap> {
  const response = await fetch(imageDataUrl(imageBase64))
  const blob = await response.blob()
  return createImageBitmap(blob)
}

async function createVisualSample(
  imageBase64: string,
  imageWidth: number,
  imageHeight: number
): Promise<VisualSample> {
  const image = await decodeImage(imageBase64)
  try {
    const width = SAMPLE_WIDTH
    const height = Math.max(
      56,
      Math.min(MAX_SAMPLE_HEIGHT, Math.round((imageHeight / imageWidth) * width))
    )
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('无法创建滚动捕获画布')
    context.drawImage(image, 0, 0, width, height)
    const pixels = context.getImageData(0, 0, width, height).data
    const luminance = new Uint8Array(width * height)
    for (let index = 0; index < luminance.length; index += 1) {
      const pixelIndex = index * 4
      luminance[index] = Math.round(
        pixels[pixelIndex] * 0.299 +
          pixels[pixelIndex + 1] * 0.587 +
          pixels[pixelIndex + 2] * 0.114
      )
    }

    const edges = new Uint8Array(width * height)
    for (let y = 1; y < height; y += 1) {
      for (let x = 1; x < width; x += 1) {
        const index = y * width + x
        const horizontal = Math.abs(luminance[index] - luminance[index - 1])
        const vertical = Math.abs(luminance[index] - luminance[index - width])
        edges[index] = Math.min(255, horizontal + vertical)
      }
    }
    return { width, height, edges }
  } finally {
    image.close()
  }
}

function correlationForShift(
  previous: VisualSample,
  incoming: VisualSample,
  shift: number,
  contentStartRatio = 0,
  contentEndRatio = 1
): number {
  const overlapHeight = previous.height - shift
  const topMargin = Math.max(2, Math.round(incoming.height * 0.17))
  const bottomMargin = Math.max(2, Math.round(incoming.height * 0.07))
  const startY = topMargin
  const endY = overlapHeight - bottomMargin
  if (endY - startY < Math.max(12, incoming.height * 0.14)) return 0

  const regionStart = Math.round(incoming.width * contentStartRatio)
  const regionEnd = Math.round(incoming.width * contentEndRatio)
  const horizontalMargin = Math.max(
    2,
    Math.round((regionEnd - regionStart) * 0.05)
  )
  const startX = Math.max(2, regionStart + horizontalMargin)
  const endX = Math.min(incoming.width - 2, regionEnd - horizontalMargin)
  let dot = 0
  let previousEnergy = 0
  let incomingEnergy = 0
  let informativePixels = 0
  let rowDot = 0
  let previousRowEnergy = 0
  let incomingRowEnergy = 0
  let informativeRows = 0

  for (let y = startY; y < endY; y += 1) {
    const previousRow = (y + shift) * previous.width
    const incomingRow = y * incoming.width
    let previousRowSum = 0
    let incomingRowSum = 0
    for (let x = startX; x < endX; x += 2) {
      const left = previous.edges[previousRow + x]
      const right = incoming.edges[incomingRow + x]
      if (left > 5 || right > 5) informativePixels += 1
      previousRowSum += left
      incomingRowSum += right
      dot += left * right
      previousEnergy += left * left
      incomingEnergy += right * right
    }
    if (previousRowSum > 12 || incomingRowSum > 12) {
      informativeRows += 1
    }
    rowDot += previousRowSum * incomingRowSum
    previousRowEnergy += previousRowSum * previousRowSum
    incomingRowEnergy += incomingRowSum * incomingRowSum
  }

  if (
    informativePixels < 80 ||
    previousEnergy === 0 ||
    incomingEnergy === 0
  ) {
    return 0
  }
  const pixelSimilarity = dot / Math.sqrt(previousEnergy * incomingEnergy)
  const rowSimilarity =
    informativeRows >= 6 &&
    previousRowEnergy > 0 &&
    incomingRowEnergy > 0
      ? rowDot / Math.sqrt(previousRowEnergy * incomingRowEnergy)
      : 0
  return Math.max(pixelSimilarity, rowSimilarity)
}

function estimateVerticalShift(
  previous: VisualSample,
  incoming: VisualSample,
  sourceWidth: number,
  sourceHeight: number,
  lockedContentX?: number,
  lockedContentWidth?: number
): ShiftMatch | null {
  if (
    previous.width !== incoming.width ||
    previous.height !== incoming.height
  ) {
    return null
  }

  const locked =
    lockedContentWidth !== undefined &&
    lockedContentX !== undefined &&
    lockedContentWidth < sourceWidth * 0.94
  const candidates = locked
    ? [
        {
          start: lockedContentX / sourceWidth,
          end: (lockedContentX + lockedContentWidth) / sourceWidth
        }
      ]
    : [
        { start: 0, end: 1 },
        { start: 0, end: 0.5 },
        { start: 0, end: 0.52 },
        { start: 0.04, end: 0.5 },
        { start: 0.48, end: 1 },
        { start: 0.5, end: 0.98 },
        { start: 0.22, end: 0.78 }
      ]
  const zeroSimilarity = correlationForShift(
    previous,
    incoming,
    0,
    locked ? candidates[0].start : 0,
    locked ? candidates[0].end : 1
  )
  const minimumShift = Math.max(
    1,
    Math.floor(previous.height * MIN_ACCEPTED_SHIFT_RATIO)
  )
  const maximumShift = Math.floor(previous.height * 0.78)
  let bestShift = minimumShift
  let bestSimilarity = 0
  let bestCandidate = candidates[0]
  let bestScore = 0
  for (const candidate of candidates) {
    const candidateZeroSimilarity = correlationForShift(
      previous,
      incoming,
      0,
      candidate.start,
      candidate.end
    )
    for (
      let shift = minimumShift;
      shift <= maximumShift;
      shift += 1
    ) {
      const similarity = correlationForShift(
        previous,
        incoming,
        shift,
        candidate.start,
        candidate.end
      )
      if (
        candidateZeroSimilarity >= 0.9 &&
        similarity <= candidateZeroSimilarity + 0.06
      ) {
        continue
      }
      const score = similarity + (candidate.end - candidate.start) * 0.035
      if (score > bestScore) {
        bestScore = score
        bestSimilarity = similarity
        bestShift = shift
        bestCandidate = candidate
      }
    }
  }
  if (
    zeroSimilarity >= 0.93 &&
    bestSimilarity < zeroSimilarity + 0.04
  ) {
    return {
      shiftPixels: 0,
      similarity: zeroSimilarity,
      contentX: lockedContentX ?? 0,
      contentWidth: lockedContentWidth ?? sourceWidth
    }
  }
  if (bestSimilarity < MIN_VISUAL_SIMILARITY) return null

  return {
    shiftPixels: Math.round((bestShift / previous.height) * sourceHeight),
    similarity: bestSimilarity,
    contentX: Math.max(0, Math.round(bestCandidate.start * sourceWidth)),
    contentWidth: Math.max(
      1,
      Math.round((bestCandidate.end - bestCandidate.start) * sourceWidth)
    )
  }
}

function frameWarnings(frames: ScrollCaptureFrame[]): string[] {
  return frames
    .map((frame, index) =>
      index > 0 && !frame.continuityConfirmed
        ? `第 ${index + 1} 个关键帧未找到可靠的图像重叠，长截图可能存在缺口`
        : ''
    )
    .filter(Boolean)
}

export function getScrollCaptureWarnings(
  frames: ScrollCaptureFrame[]
): string[] {
  return frameWarnings(frames)
}

export async function appendScrollCaptureFrame(
  frames: ScrollCaptureFrame[],
  payload: MentorCapturePayload,
  force = false
): Promise<ScrollCaptureAppendResult> {
  if (frames.length >= MAX_ACCEPTED_FRAMES) {
    return {
      frames,
      accepted: false,
      warnings: [
        ...frameWarnings(frames),
        `滚动内容超过 ${MAX_ACCEPTED_FRAMES} 个关键帧，已停止继续追加`
      ],
      lastStep: null
    }
  }

  const sample = await createVisualSample(
    payload.imageBase64,
    payload.imageWidth,
    payload.imageHeight
  )
  const capturedAt = Date.now()
  if (frames.length === 0) {
    const first: ScrollCaptureFrame = {
      imageBase64: payload.imageBase64,
      width: payload.imageWidth,
      height: payload.imageHeight,
      contentX: 0,
      contentWidth: payload.imageWidth,
      addedPixels: payload.imageHeight,
      continuityConfirmed: true,
      similarity: 1,
      capturedAt,
      sample
    }
    return {
      frames: [first],
      accepted: true,
      warnings: [],
      lastStep: {
        overlapLines: 0,
        similarity: 1,
        addedLines: 1,
        duplicate: false,
        continuityConfirmed: true
      }
    }
  }

  const previous = frames[frames.length - 1]
  if (
    previous.width !== payload.imageWidth ||
    previous.height !== payload.imageHeight
  ) {
    throw new Error('滚动捕获区域尺寸发生变化，请取消后重新选区')
  }

  const match = estimateVerticalShift(
    previous.sample,
    sample,
    payload.imageWidth,
    payload.imageHeight,
    previous.contentX,
    previous.contentWidth
  )
  const minimumShift = payload.imageHeight * MIN_ACCEPTED_SHIFT_RATIO
  if (match && match.shiftPixels < minimumShift && !force) {
    return {
      frames,
      accepted: false,
      warnings: frameWarnings(frames),
      lastStep: {
        overlapLines: 1,
        similarity: match.similarity,
        addedLines: 0,
        duplicate: true,
        continuityConfirmed: true
      }
    }
  }
  if (match && match.shiftPixels < payload.imageHeight * 0.012) {
    return {
      frames,
      accepted: false,
      warnings: frameWarnings(frames),
      lastStep: {
        overlapLines: 1,
        similarity: match.similarity,
        addedLines: 0,
        duplicate: true,
        continuityConfirmed: true
      }
    }
  }

  if (!match && !force) {
    return {
      frames,
      accepted: false,
      warnings: frameWarnings(frames),
      lastStep: {
        overlapLines: 0,
        similarity: 0,
        addedLines: 0,
        duplicate: false,
        continuityConfirmed: false
      }
    }
  }

  const continuityConfirmed = Boolean(match)
  const addedPixels = match
    ? Math.max(1, Math.min(payload.imageHeight, match.shiftPixels))
    : payload.imageHeight
  const contentX = match?.contentX ?? previous.contentX
  const contentWidth = match?.contentWidth ?? previous.contentWidth
  const normalizedFrames =
    previous.contentWidth === previous.width && contentWidth < previous.width
      ? frames.map((frame) => ({
          ...frame,
          contentX,
          contentWidth
        }))
      : frames
  const next: ScrollCaptureFrame = {
    imageBase64: payload.imageBase64,
    width: payload.imageWidth,
    height: payload.imageHeight,
    contentX,
    contentWidth,
    addedPixels,
    continuityConfirmed,
    similarity: match?.similarity ?? 0,
    capturedAt,
    sample
  }
  const nextFrames = [...normalizedFrames, next]
  return {
    frames: nextFrames,
    accepted: true,
    warnings: frameWarnings(nextFrames),
    lastStep: {
      overlapLines: continuityConfirmed ? 1 : 0,
      similarity: next.similarity,
      addedLines: 1,
      duplicate: false,
      continuityConfirmed
    }
  }
}

async function buildLongCaptureTiles(
  frames: ScrollCaptureFrame[]
): Promise<{ tiles: CaptureTile[]; totalHeight: number }> {
  if (frames.length === 0) {
    throw new Error('没有可生成长截图的关键帧')
  }

  const images = await Promise.all(
    frames.map((frame) => decodeImage(frame.imageBase64))
  )
  try {
    const pieces: CapturePiece[] = []
    let totalHeight = 0
    frames.forEach((frame, index) => {
      const pieceHeight =
        index === 0 || !frame.continuityConfirmed
          ? frame.height
          : Math.max(1, Math.min(frame.height, frame.addedPixels))
      const sourceY =
        index === 0 || !frame.continuityConfirmed
          ? 0
          : frame.height - pieceHeight
      pieces.push({
        image: images[index],
        sourceX: frame.contentX,
        sourceY,
        width: frame.contentWidth,
        height: pieceHeight,
        destinationY: totalHeight
      })
      totalHeight += pieceHeight
    })

    if (totalHeight > MAX_COMPOSED_HEIGHT) {
      throw new Error(
        `长截图高度 ${totalHeight}px 超过 ${MAX_COMPOSED_HEIGHT}px，请缩小选区或分两次采集`
      )
    }

    const width = frames[0].contentWidth
    const tiles: CaptureTile[] = []
    const tileStep = TILE_HEIGHT - TILE_OVERLAP
    for (let tileStart = 0; tileStart < totalHeight; tileStart += tileStep) {
      const tileHeight = Math.min(TILE_HEIGHT, totalHeight - tileStart)
      const tileEnd = tileStart + tileHeight
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = tileHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('无法创建长截图图块')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, width, tileHeight)

      for (const piece of pieces) {
        const pieceEnd = piece.destinationY + piece.height
        const intersectionStart = Math.max(tileStart, piece.destinationY)
        const intersectionEnd = Math.min(tileEnd, pieceEnd)
        if (intersectionEnd <= intersectionStart) continue
        const offset = intersectionStart - piece.destinationY
        const drawHeight = intersectionEnd - intersectionStart
        context.drawImage(
          piece.image,
          piece.sourceX,
          piece.sourceY + offset,
          piece.width,
          drawHeight,
          0,
          intersectionStart - tileStart,
          width,
          drawHeight
        )
      }
      tiles.push({
        imageBase64: canvas.toDataURL('image/png'),
        width,
        height: tileHeight
      })
    }

    return { tiles, totalHeight }
  } finally {
    images.forEach((image) => image.close())
  }
}

function qualityForRecognition(
  confidence: number,
  text: string,
  hasWarnings: boolean
): 'high' | 'medium' | 'low' {
  if (
    hasWarnings ||
    !Number.isFinite(confidence) ||
    confidence < 45 ||
    text.replace(/\s/gu, '').length < 24
  ) {
    return 'low'
  }
  return confidence < 72 ? 'medium' : 'high'
}

export async function recognizeLongCapture(
  frames: ScrollCaptureFrame[],
  visualWarnings: string[],
  onProgress?: (completed: number, total: number) => void
): Promise<LongCaptureRecognition> {
  const composition = await buildLongCaptureTiles(frames)
  const recognizedFrames: OcrCaptureFrame[] = []
  let usedFallback = false

  for (let index = 0; index < composition.tiles.length; index += 1) {
    const tile = composition.tiles[index]
    try {
      const vision = await window.inview.recognizeMentorImage(tile.imageBase64)
      if (!vision.text.trim()) {
        throw new Error('Vision 未识别到文字')
      }
      recognizedFrames.push({
        rawText: vision.text,
        analysisText: vision.text,
        confidence: vision.confidence,
        inputQuality: qualityForRecognition(
          vision.confidence,
          vision.text,
          false
        ),
        capturedAt: Date.now()
      })
    } catch (error) {
      console.warn('[mentor] Vision OCR 失败，回退 Tesseract:', error)
      usedFallback = true
      const fallback = await recognizeScreenText(tile.imageBase64, {
        imageWidth: tile.width,
        imageHeight: tile.height,
        filterTopChrome: false
      })
      recognizedFrames.push({
        rawText: fallback.rawText,
        analysisText: fallback.analysisText,
        confidence: fallback.confidence,
        inputQuality: qualityForRecognition(
          fallback.confidence,
          fallback.analysisText,
          fallback.usedFallback
        ),
        capturedAt: Date.now()
      })
    }
    onProgress?.(index + 1, composition.tiles.length)
  }

  const stitched = stitchOcrFrames(recognizedFrames)
  const warnings = [...visualWarnings, ...stitched.warnings]
  const confidence =
    recognizedFrames.length > 0
      ? recognizedFrames.reduce((sum, frame) => sum + frame.confidence, 0) /
        recognizedFrames.length
      : 0
  return {
    text: stitched.text,
    confidence,
    inputQuality: qualityForRecognition(
      confidence,
      stitched.text,
      warnings.length > 0
    ),
    warnings,
    tileCount: composition.tiles.length,
    totalHeight: composition.totalHeight,
    engine: usedFallback ? 'mixed' : 'apple-vision'
  }
}
