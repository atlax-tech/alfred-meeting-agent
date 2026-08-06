export interface OcrBoundingBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface OcrLayoutLine {
  text: string
  confidence: number
  bbox: OcrBoundingBox
  rowHeight: number
}

export interface OcrLayoutBlock {
  text: string
  confidence: number
  bbox: OcrBoundingBox
  lines: OcrLayoutLine[]
}

export interface OcrImageSize {
  width: number
  height: number
}

export interface OcrContentSelection {
  text: string
  selectedBlockIndexes: number[]
  discardedBlockIndexes: number[]
  chromeBoundary: number | null
  usedFallback: boolean
}

export interface OcrContentFilterOptions {
  filterTopChrome?: boolean
}

const UI_LABEL_PATTERN =
  /(?:^|\s)(?:chrome|safari|firefox|edge|file|edit|view|history|bookmarks|window|help|文件|编辑|显示|历史|记录|书签|窗口|帮助)(?:\s|$)/iu
const URL_PATTERN = /^(?:https?:\/\/|www\.|[a-z0-9.-]+\.(?:com|cn|net|org|io)(?:\/|$))/iu
const QUESTION_PATTERN =
  /(?:\?|？|问题|题目|question|which|what|why|how|选择|判断|填空|简述|分析)/iu
const OPTION_PATTERN = /^(?:[A-Ha-h][.)、:]|[①②③④⑤⑥⑦⑧]|[一二三四五六七八][、.])/u
const CODE_PATTERN =
  /(?:\b(?:function|class|const|let|var|return|public|private|def|import|SELECT|FROM|WHERE)\b|[{}[\]();]|=>)/u

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function nonWhitespaceLength(text: string): number {
  return text.replace(/\s/gu, '').length
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function getLineHeight(line: OcrLayoutLine): number {
  return Math.max(line.rowHeight, line.bbox.y1 - line.bbox.y0, 1)
}

function blockMedianLineHeight(block: OcrLayoutBlock): number {
  return median(block.lines.map(getLineHeight))
}

function symbolRatio(text: string): number {
  const characters = [...text].filter((character) => !/\s/u.test(character))
  if (characters.length === 0) return 1
  const symbols = characters.filter(
    (character) => !/[\p{L}\p{N}.,!?，。！？:：;；'’"“”()（）[\]{}<>\-_+/\\=]/u.test(character)
  )
  return symbols.length / characters.length
}

function isLikelyUiBlock(
  block: OcrLayoutBlock,
  imageSize: OcrImageSize,
  globalMedianLineHeight: number
): boolean {
  const text = normalizeText(block.text)
  const lineHeight = blockMedianLineHeight(block)
  const relativeBottom = block.bbox.y1 / Math.max(imageSize.height, 1)
  const isSmallTopText =
    relativeBottom <= 0.2 &&
    globalMedianLineHeight > 0 &&
    lineHeight <= globalMedianLineHeight * 0.78

  return (
    URL_PATTERN.test(text) ||
    UI_LABEL_PATTERN.test(text) ||
    isSmallTopText ||
    (relativeBottom <= 0.16 && block.lines.length <= 2 && symbolRatio(text) >= 0.32)
  )
}

function findChromeBoundary(
  blocks: OcrLayoutBlock[],
  imageSize: OcrImageSize,
  globalMedianLineHeight: number
): number | null {
  if (blocks.length < 2 || imageSize.height <= 0) return null

  const sorted = blocks
    .map((block, index) => ({ block, index }))
    .sort((left, right) => left.block.bbox.y0 - right.block.bbox.y0)
  const totalLength = blocks.reduce((sum, block) => sum + nonWhitespaceLength(block.text), 0)
  let bestBoundary: number | null = null
  let bestScore = Number.NEGATIVE_INFINITY
  let upperBottom = sorted[0].block.bbox.y1

  for (let index = 0; index < sorted.length - 1; index += 1) {
    upperBottom = Math.max(upperBottom, sorted[index].block.bbox.y1)
    const nextTop = sorted[index + 1].block.bbox.y0
    const gap = nextTop - upperBottom
    const upperBlocks = sorted.slice(0, index + 1).map((item) => item.block)
    const lowerBlocks = sorted.slice(index + 1).map((item) => item.block)
    const lowerLength = lowerBlocks.reduce(
      (sum, block) => sum + nonWhitespaceLength(block.text),
      0
    )
    const uiBlockCount = upperBlocks.filter((block) =>
      isLikelyUiBlock(block, imageSize, globalMedianLineHeight)
    ).length
    const uiRatio = uiBlockCount / upperBlocks.length
    const minimumGap = Math.max(18, imageSize.height * 0.018, globalMedianLineHeight * 0.75)
    const hasEnoughBodyText = lowerLength >= Math.max(16, totalLength * 0.2)
    const isPlausibleChromeBand = upperBottom <= imageSize.height * 0.24

    if (
      gap < minimumGap ||
      !hasEnoughBodyText ||
      !isPlausibleChromeBand ||
      uiRatio < 0.5
    ) {
      continue
    }

    const score = gap / imageSize.height + uiRatio * 0.1
    if (score > bestScore) {
      bestScore = score
      bestBoundary = nextTop
    }
  }

  return bestBoundary
}

function scoreBlock(
  block: OcrLayoutBlock,
  imageSize: OcrImageSize,
  globalMedianLineHeight: number,
  chromeBoundary: number | null
): number {
  const text = normalizeText(block.text)
  const characterCount = nonWhitespaceLength(text)
  const lineCount = Math.max(1, block.lines.length)
  const averageLineLength = characterCount / lineCount
  const confidence = Math.max(0, Math.min(100, block.confidence)) / 100
  let score = Math.log2(characterCount + 1) + confidence

  if (lineCount >= 2) score += Math.min(1.5, lineCount * 0.3)
  if (averageLineLength >= 18) score += 0.8
  if (QUESTION_PATTERN.test(text)) score += 1.1
  if (OPTION_PATTERN.test(text) || CODE_PATTERN.test(text)) score += 0.8
  if (characterCount <= 3) score -= 3
  if (block.confidence < 35) score -= 1.5
  if (symbolRatio(text) >= 0.45) score -= 1.8
  if (isLikelyUiBlock(block, imageSize, globalMedianLineHeight)) score -= 3.5
  if (chromeBoundary !== null && block.bbox.y1 < chromeBoundary) score -= 5

  return score
}

export function selectPrimaryOcrContent(
  rawText: string,
  blocks: OcrLayoutBlock[],
  imageSize: OcrImageSize,
  options: OcrContentFilterOptions = {}
): OcrContentSelection {
  const normalizedRawText = normalizeText(rawText)
  if (!normalizedRawText || blocks.length === 0) {
    return {
      text: normalizedRawText,
      selectedBlockIndexes: [],
      discardedBlockIndexes: [],
      chromeBoundary: null,
      usedFallback: true
    }
  }

  const lineHeights = blocks.flatMap((block) => block.lines.map(getLineHeight))
  const globalMedianLineHeight = median(lineHeights)
  const chromeBoundary =
    options.filterTopChrome === false
      ? null
      : findChromeBoundary(blocks, imageSize, globalMedianLineHeight)
  const scored = blocks.map((block, index) => ({
    block,
    index,
    score: scoreBlock(block, imageSize, globalMedianLineHeight, chromeBoundary)
  }))
  const selected = scored
    .filter(({ block, score }) => nonWhitespaceLength(block.text) >= 4 && score >= 2.2)
    .sort((left, right) => {
      const verticalDifference = left.block.bbox.y0 - right.block.bbox.y0
      return verticalDifference === 0
        ? left.block.bbox.x0 - right.block.bbox.x0
        : verticalDifference
    })

  if (selected.length === 0) {
    const fallbackBlocks = [...scored]
      .filter(({ block }) => nonWhitespaceLength(block.text) >= 2)
      .sort((left, right) => right.score - left.score)
      .slice(0, 3)
      .sort((left, right) => left.block.bbox.y0 - right.block.bbox.y0)
    const fallbackText = normalizeText(
      fallbackBlocks.map(({ block }) => normalizeText(block.text)).join('\n\n')
    )

    return {
      text: fallbackText || normalizedRawText,
      selectedBlockIndexes: fallbackBlocks.map(({ index }) => index),
      discardedBlockIndexes: scored
        .filter(({ index }) => !fallbackBlocks.some((item) => item.index === index))
        .map(({ index }) => index),
      chromeBoundary,
      usedFallback: true
    }
  }

  const selectedIndexes = selected.map(({ index }) => index)
  return {
    text: normalizeText(selected.map(({ block }) => normalizeText(block.text)).join('\n\n')),
    selectedBlockIndexes: selectedIndexes,
    discardedBlockIndexes: scored
      .filter(({ index }) => !selectedIndexes.includes(index))
      .map(({ index }) => index),
    chromeBoundary,
    usedFallback: false
  }
}
