/**
 * 屏幕 OCR 服务
 * Worker 采用单例并在应用启动时预热，避免每次截图重复加载语言模型。
 */

import { createWorker, OEM, PSM, type Worker } from 'tesseract.js'
import {
  selectPrimaryOcrContent,
  type OcrImageSize,
  type OcrLayoutBlock
} from './ocr-content-filter'

const OCR_LANGUAGES = 'chi_sim+eng'

let workerPromise: Promise<Worker> | null = null

export interface ScreenTextRecognitionOptions {
  imageWidth?: number
  imageHeight?: number
  filterTopChrome?: boolean
}

export interface ScreenTextRecognitionResult {
  rawText: string
  analysisText: string
  confidence: number
  blockCount: number
  selectedBlockCount: number
  discardedBlockCount: number
  usedFallback: boolean
}

export function initializeOcr(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker(OCR_LANGUAGES, OEM.LSTM_ONLY)
      .then(async (worker) => {
        // tesseract.js v7 已在 createWorker 内部完成 loadLanguage；
        // 保留兼容分支，使旧版 Worker 也能显式加载中英文语言包。
        const legacyWorker = worker as Worker & {
          loadLanguage?: (languages: string) => Promise<unknown>
        }
        if (typeof legacyWorker.loadLanguage === 'function') {
          await legacyWorker.loadLanguage(OCR_LANGUAGES)
        }
        await worker.setParameters({
          tessedit_pageseg_mode: PSM.AUTO,
          preserve_interword_spaces: '1'
        })
        return worker
      })
      .catch((err) => {
        workerPromise = null
        throw err
      })
  }

  return workerPromise
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function recognizeScreenText(
  imageBase64: string,
  options: ScreenTextRecognitionOptions = {}
): Promise<ScreenTextRecognitionResult> {
  if (!imageBase64.trim()) {
    throw new Error('截屏数据为空')
  }

  const worker = await initializeOcr()
  const image = imageBase64.startsWith('data:')
    ? imageBase64
    : `data:image/png;base64,${imageBase64}`
  const result = await worker.recognize(image, {}, { text: true, blocks: true })
  console.log('[OCR] text length:', result.data.text.length, 'confidence:', result.data.confidence)

  const rawText = normalizeText(result.data.text)
  const blocks: OcrLayoutBlock[] = (result.data.blocks ?? []).map((block) => ({
    text: normalizeText(block.text),
    confidence: block.confidence,
    bbox: block.bbox,
    lines: block.paragraphs.flatMap((paragraph) =>
      paragraph.lines.map((line) => ({
        text: normalizeText(line.text),
        confidence: line.confidence,
        bbox: line.bbox,
        rowHeight: line.rowAttributes.rowHeight
      }))
    )
  }))
  const inferredSize: OcrImageSize = {
    width:
      options.imageWidth ??
      Math.max(1, ...blocks.map((block) => block.bbox.x1)),
    height:
      options.imageHeight ??
      Math.max(1, ...blocks.map((block) => block.bbox.y1))
  }
  const selection = selectPrimaryOcrContent(rawText, blocks, inferredSize, {
    filterTopChrome: options.filterTopChrome
  })

  console.log('[OCR] content selection:', {
    blocks: blocks.length,
    selected: selection.selectedBlockIndexes.length,
    discarded: selection.discardedBlockIndexes.length,
    rawLength: rawText.length,
    analysisLength: selection.text.length,
    chromeBoundary: selection.chromeBoundary,
    usedFallback: selection.usedFallback
  })

  return {
    rawText,
    analysisText: selection.text || rawText,
    confidence: result.data.confidence,
    blockCount: blocks.length,
    selectedBlockCount: selection.selectedBlockIndexes.length,
    discardedBlockCount: selection.discardedBlockIndexes.length,
    usedFallback: selection.usedFallback
  }
}
