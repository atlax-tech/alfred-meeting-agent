function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

function titleCandidates(windowTitle: string): string[] {
  const trimmed = windowTitle.trim()
  const withoutBrowserSuffix = trimmed.replace(
    /\s+-\s+(?:Google Chrome|Microsoft Edge|Safari|Firefox)$/iu,
    ''
  )
  const withoutSiteSuffix = withoutBrowserSuffix.replace(
    /\s+-\s+(?:力扣（LeetCode）|LeetCode)$/iu,
    ''
  )
  return [trimmed, withoutBrowserSuffix, withoutSiteSuffix]
    .map((title) => normalizeForMatch(title))
    .filter((title, index, titles) => title.length >= 8 && titles.indexOf(title) === index)
}

function isLikelyTitle(line: string, candidates: string[]): boolean {
  const normalized = normalizeForMatch(line)
  if (normalized.length < 8) return false
  return candidates.some(
    (candidate) =>
      normalized === candidate ||
      (normalized.length >= 12 && candidate.startsWith(normalized)) ||
      (candidate.length >= 12 && normalized.startsWith(candidate))
  )
}

function repairSuperscriptLines(lines: string[]): string[] {
  const repaired: string[] = []
  for (const line of lines) {
    if (
      /^[0-9]+$/u.test(line) &&
      repaired.length > 0 &&
      /(?:<=|≥|≤)\s*10$/u.test(repaired[repaired.length - 1])
    ) {
      repaired[repaired.length - 1] += `^${line}`
      continue
    }
    if (repaired[repaired.length - 1] !== line) {
      repaired.push(line)
    }
  }
  return repaired
}

export interface AccessibilityContentSelection {
  text: string
  lineCount: number
  isolatedPrimaryContent: boolean
}

export function selectAccessibilityPrimaryContent(
  rawText: string,
  windowTitle: string
): AccessibilityContentSelection {
  const lines = rawText
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/gu, ' ').trim())
    .filter(Boolean)
  const candidates = titleCandidates(windowTitle)
  const titleIndex = lines.findIndex((line) => isLikelyTitle(line, candidates))
  const startIndex = titleIndex >= 0 ? titleIndex : 0
  const terminalMarkers = [
    /^面试中遇到过这道题/u,
    /^评论\s*[（(]/u,
    /^贡献者$/u
  ]
  let endIndex = lines.length
  for (let index = startIndex + 8; index < lines.length; index += 1) {
    if (terminalMarkers.some((pattern) => pattern.test(lines[index]))) {
      endIndex = index
      break
    }
  }

  const repaired = repairSuperscriptLines(lines.slice(startIndex, endIndex))
  const text = repaired.join('\n').slice(0, 40_000).trim()
  return {
    text,
    lineCount: repaired.length,
    isolatedPrimaryContent: titleIndex >= 0 && endIndex < lines.length
  }
}
