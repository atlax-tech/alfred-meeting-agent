export interface OcrCaptureFrame {
  rawText: string
  analysisText: string
  confidence: number
  inputQuality: 'high' | 'medium' | 'low'
  capturedAt: number
}

export interface OcrStitchStep {
  overlapLines: number
  similarity: number
  addedLines: number
  duplicate: boolean
  continuityConfirmed: boolean
}

export interface OcrStitchResult {
  text: string
  warnings: string[]
  lastStep: OcrStitchStep | null
}

interface OverlapCandidate {
  existingStart: number
  incomingStart: number
  lineCount: number
  similarity: number
  matchedCharacters: number
}

const MAX_OVERLAP_LINES = 24
const MAX_LEADING_UI_LINES = 4

function textLines(text: string): string[] {
  return text
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/gu, ' ').trim())
    .filter(Boolean)
}

function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

function bigramCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  if (text.length < 2) {
    if (text) counts.set(text, 1)
    return counts
  }

  for (let index = 0; index < text.length - 1; index += 1) {
    const bigram = text.slice(index, index + 2)
    counts.set(bigram, (counts.get(bigram) ?? 0) + 1)
  }
  return counts
}

function lineSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeForMatch(left)
  const normalizedRight = normalizeForMatch(right)
  if (!normalizedLeft || !normalizedRight) return 0
  if (normalizedLeft === normalizedRight) return 1

  if (normalizedLeft.length <= 3 || normalizedRight.length <= 3) {
    return 0
  }

  const leftCounts = bigramCounts(normalizedLeft)
  const rightCounts = bigramCounts(normalizedRight)
  let intersection = 0
  for (const [bigram, leftCount] of leftCounts) {
    intersection += Math.min(leftCount, rightCounts.get(bigram) ?? 0)
  }
  const leftTotal = [...leftCounts.values()].reduce((sum, count) => sum + count, 0)
  const rightTotal = [...rightCounts.values()].reduce((sum, count) => sum + count, 0)
  return (2 * intersection) / Math.max(1, leftTotal + rightTotal)
}

function scoreOverlap(
  existingLines: string[],
  incomingLines: string[],
  existingStart: number,
  incomingStart: number,
  lineCount: number
): OverlapCandidate | null {
  let weightedSimilarity = 0
  let totalWeight = 0
  let matchedCharacters = 0
  let weakestSimilarity = 1

  for (let offset = 0; offset < lineCount; offset += 1) {
    const existing = existingLines[existingStart + offset]
    const incoming = incomingLines[incomingStart + offset]
    const similarity = lineSimilarity(existing, incoming)
    const weight = Math.max(
      4,
      Math.min(
        normalizeForMatch(existing).length,
        normalizeForMatch(incoming).length
      )
    )
    weightedSimilarity += similarity * weight
    totalWeight += weight
    matchedCharacters += weight
    weakestSimilarity = Math.min(weakestSimilarity, similarity)
  }

  const similarity = weightedSimilarity / Math.max(1, totalWeight)
  const enoughEvidence =
    (lineCount >= 2 && matchedCharacters >= 16 && similarity >= 0.82) ||
    (lineCount === 1 && matchedCharacters >= 28 && similarity >= 0.9)
  if (!enoughEvidence || weakestSimilarity < 0.58) return null

  return {
    existingStart,
    incomingStart,
    lineCount,
    similarity,
    matchedCharacters
  }
}

function findOverlap(
  existingLines: string[],
  incomingLines: string[]
): OverlapCandidate | null {
  let best: OverlapCandidate | null = null
  const maxIncomingStart = Math.min(
    MAX_LEADING_UI_LINES,
    Math.max(0, incomingLines.length - 1)
  )

  for (let incomingStart = 0; incomingStart <= maxIncomingStart; incomingStart += 1) {
    const maxLineCount = Math.min(
      MAX_OVERLAP_LINES,
      existingLines.length,
      incomingLines.length - incomingStart
    )
    for (let lineCount = 1; lineCount <= maxLineCount; lineCount += 1) {
      const existingStart = existingLines.length - lineCount
      const candidate = scoreOverlap(
        existingLines,
        incomingLines,
        existingStart,
        incomingStart,
        lineCount
      )
      if (!candidate) continue

      if (
        !best ||
        candidate.matchedCharacters > best.matchedCharacters ||
        (candidate.matchedCharacters === best.matchedCharacters &&
          candidate.similarity > best.similarity)
      ) {
        best = candidate
      }
    }
  }

  return best
}

function appendFrame(existingText: string, incomingText: string): {
  text: string
  step: OcrStitchStep
} {
  const existingLines = textLines(existingText)
  const incomingLines = textLines(incomingText)
  if (existingLines.length === 0) {
    return {
      text: incomingLines.join('\n'),
      step: {
        overlapLines: 0,
        similarity: 1,
        addedLines: incomingLines.length,
        duplicate: false,
        continuityConfirmed: true
      }
    }
  }
  if (incomingLines.length === 0) {
    return {
      text: existingLines.join('\n'),
      step: {
        overlapLines: 0,
        similarity: 0,
        addedLines: 0,
        duplicate: true,
        continuityConfirmed: false
      }
    }
  }

  const normalizedExisting = normalizeForMatch(existingLines.join('\n'))
  const normalizedIncoming = normalizeForMatch(incomingLines.join('\n'))
  if (
    normalizedIncoming.length >= 16 &&
    normalizedExisting.endsWith(normalizedIncoming)
  ) {
    return {
      text: existingLines.join('\n'),
      step: {
        overlapLines: incomingLines.length,
        similarity: 1,
        addedLines: 0,
        duplicate: true,
        continuityConfirmed: true
      }
    }
  }

  const overlap = findOverlap(existingLines, incomingLines)
  if (!overlap) {
    return {
      text: [...existingLines, ...incomingLines].join('\n'),
      step: {
        overlapLines: 0,
        similarity: 0,
        addedLines: incomingLines.length,
        duplicate: false,
        continuityConfirmed: false
      }
    }
  }

  const newLines = incomingLines.slice(overlap.incomingStart + overlap.lineCount)
  return {
    text: [...existingLines, ...newLines].join('\n'),
    step: {
      overlapLines: overlap.lineCount,
      similarity: overlap.similarity,
      addedLines: newLines.length,
      duplicate: newLines.length === 0,
      continuityConfirmed: true
    }
  }
}

export function stitchOcrFrames(frames: OcrCaptureFrame[]): OcrStitchResult {
  let text = ''
  const warnings: string[] = []
  let lastStep: OcrStitchStep | null = null

  frames.forEach((frame, index) => {
    const appended = appendFrame(text, frame.analysisText || frame.rawText)
    text = appended.text
    lastStep = appended.step
    if (index > 0 && !appended.step.continuityConfirmed) {
      warnings.push(
        `第 ${index + 1} 段未检测到可靠重叠，内容之间可能存在缺口或滚动过多`
      )
    }
  })

  return { text, warnings, lastStep }
}
