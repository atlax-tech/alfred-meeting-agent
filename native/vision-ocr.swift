import AppKit
import ApplicationServices
import Foundation
import ImageIO
import Vision

struct BoundingBox: Codable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct RecognizedLine: Codable {
  let text: String
  let confidence: Double
  let boundingBox: BoundingBox
}

struct RecognitionResult: Codable {
  let text: String
  let confidence: Double
  let lines: [RecognizedLine]
  let engine: String
}

struct FrontmostWindowResult: Codable {
  let windowId: Int
  let x: Double
  let y: Double
  let width: Double
  let height: Double
  let ownerName: String
  let windowName: String
  let processId: Int32
}

struct AccessibilityTextResult: Codable {
  let text: String
  let lineCount: Int
  let nodeCount: Int
  let truncated: Bool
  let programmingLanguage: String?
  let engine: String
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

func argumentValue(prefix: String) -> String? {
  CommandLine.arguments
    .first(where: { $0.hasPrefix(prefix) })
    .map { String($0.dropFirst(prefix.count)) }
}

func normalizedTitle(_ value: String) -> String {
  value
    .lowercased()
    .replacingOccurrences(of: " - google chrome", with: "")
    .replacingOccurrences(of: " - microsoft edge", with: "")
    .replacingOccurrences(of: " - safari", with: "")
    .filter { !$0.isWhitespace && !$0.isPunctuation }
}

func accessibilityString(
  _ element: AXUIElement,
  _ attribute: CFString
) -> String? {
  var rawValue: CFTypeRef?
  guard
    AXUIElementCopyAttributeValue(element, attribute, &rawValue) == .success,
    let rawValue,
    CFGetTypeID(rawValue) == CFStringGetTypeID()
  else {
    return nil
  }
  return (rawValue as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
}

func accessibilityChildren(_ element: AXUIElement) -> [AXUIElement] {
  var rawValue: CFTypeRef?
  guard
    AXUIElementCopyAttributeValue(
      element,
      kAXChildrenAttribute as CFString,
      &rawValue
    ) == .success,
    let children = rawValue as? [AXUIElement]
  else {
    return []
  }
  return children
}

func accessibilityWindows(_ application: AXUIElement) -> [AXUIElement] {
  var rawValue: CFTypeRef?
  guard
    AXUIElementCopyAttributeValue(
      application,
      kAXWindowsAttribute as CFString,
      &rawValue
    ) == .success,
    let windows = rawValue as? [AXUIElement]
  else {
    return []
  }
  return windows
}

func normalizedProgrammingLanguage(_ value: String) -> String? {
  let normalized = value
    .replacingOccurrences(of: "\u{00a0}", with: " ")
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased()
    .replacingOccurrences(
      of: #"\s+"#,
      with: " ",
      options: .regularExpression
    )
  let languages: [String: String] = [
    "c": "C",
    "c++": "C++",
    "cpp": "C++",
    "c#": "C#",
    "csharp": "C#",
    "java": "Java",
    "javascript": "JavaScript",
    "typescript": "TypeScript",
    "python": "Python",
    "python2": "Python2",
    "python3": "Python3",
    "go": "Go",
    "golang": "Go",
    "rust": "Rust",
    "swift": "Swift",
    "kotlin": "Kotlin",
    "dart": "Dart",
    "ruby": "Ruby",
    "scala": "Scala",
    "php": "PHP",
    "racket": "Racket",
    "erlang": "Erlang",
    "elixir": "Elixir",
    "bash": "Bash",
    "mysql": "MySQL",
    "ms sql server": "MS SQL Server",
    "mssql": "MS SQL Server",
    "oracle": "Oracle",
    "pandas": "Pandas"
  ]
  return languages[normalized]
}

func accessibilityPoint(
  _ element: AXUIElement,
  _ attribute: CFString
) -> CGPoint? {
  var rawValue: CFTypeRef?
  guard
    AXUIElementCopyAttributeValue(element, attribute, &rawValue) == .success,
    let rawValue,
    CFGetTypeID(rawValue) == AXValueGetTypeID()
  else {
    return nil
  }
  let value = rawValue as! AXValue
  var point = CGPoint.zero
  guard AXValueGetValue(value, .cgPoint, &point) else {
    return nil
  }
  return point
}

func accessibilitySize(
  _ element: AXUIElement,
  _ attribute: CFString
) -> CGSize? {
  var rawValue: CFTypeRef?
  guard
    AXUIElementCopyAttributeValue(element, attribute, &rawValue) == .success,
    let rawValue,
    CFGetTypeID(rawValue) == AXValueGetTypeID()
  else {
    return nil
  }
  let value = rawValue as! AXValue
  var size = CGSize.zero
  guard AXValueGetValue(value, .cgSize, &size) else {
    return nil
  }
  return size
}

func matchingWindow(
  application: AXUIElement,
  targetTitle: String
) -> AXUIElement? {
  let windows = accessibilityWindows(application)
  guard !windows.isEmpty else {
    return nil
  }
  let normalizedTarget = normalizedTitle(targetTitle)
  if !normalizedTarget.isEmpty {
    let scored = windows.map { window -> (AXUIElement, Int) in
      let title = accessibilityString(
        window,
        kAXTitleAttribute as CFString
      ) ?? ""
      let normalizedWindowTitle = normalizedTitle(title)
      let score: Int
      if normalizedWindowTitle == normalizedTarget {
        score = 10_000 + normalizedWindowTitle.count
      } else if
        normalizedWindowTitle.contains(normalizedTarget) ||
        normalizedTarget.contains(normalizedWindowTitle)
      {
        score = 5_000 + min(
          normalizedWindowTitle.count,
          normalizedTarget.count
        )
      } else {
        score = 0
      }
      return (window, score)
    }
    if let best = scored.max(by: { $0.1 < $1.1 }), best.1 > 0 {
      return best.0
    }
  }

  var focusedValue: CFTypeRef?
  if
    AXUIElementCopyAttributeValue(
      application,
      kAXFocusedWindowAttribute as CFString,
      &focusedValue
    ) == .success,
    let focusedValue,
    CFGetTypeID(focusedValue) == AXUIElementGetTypeID()
  {
    return (focusedValue as! AXUIElement)
  }
  return windows[0]
}

func matchingWebArea(
  root: AXUIElement,
  targetTitle: String
) -> AXUIElement? {
  let normalizedTarget = normalizedTitle(targetTitle)
  var stack: [(AXUIElement, Int)] = [(root, 0)]
  var fallback: AXUIElement?
  var best: (AXUIElement, Int)?
  var visited = 0

  while let (element, depth) = stack.popLast() {
    visited += 1
    if visited > 5_000 || depth > 45 {
      continue
    }
    let role = accessibilityString(
      element,
      kAXRoleAttribute as CFString
    )
    if role == "AXWebArea" {
      if fallback == nil {
        fallback = element
      }
      let title = accessibilityString(
        element,
        kAXTitleAttribute as CFString
      ) ?? ""
      let normalizedWebTitle = normalizedTitle(title)
      let score: Int
      if
        !normalizedTarget.isEmpty &&
        normalizedWebTitle == normalizedTarget
      {
        score = 10_000 + normalizedWebTitle.count
      } else if
        !normalizedTarget.isEmpty &&
        (
          normalizedWebTitle.contains(normalizedTarget) ||
          normalizedTarget.contains(normalizedWebTitle)
        )
      {
        score = 5_000 + min(normalizedWebTitle.count, normalizedTarget.count)
      } else {
        score = normalizedWebTitle.count
      }
      if best == nil || score > best!.1 {
        best = (element, score)
      }
    }
    for child in accessibilityChildren(element).reversed() {
      stack.append((child, depth + 1))
    }
  }
  return best?.0 ?? fallback
}

func accessibilityText(
  root: AXUIElement,
  window: AXUIElement,
  contentStartRatio: Double,
  contentEndRatio: Double
) -> AccessibilityTextResult {
  let textRoles: Set<String> = [
    "AXStaticText",
    "AXHeading",
    "AXLink",
    "AXCell"
  ]
  let skippedRoles: Set<String> = [
    "AXImage",
    "AXScrollBar",
    "AXSplitter",
    "AXToolbar",
    "AXMenu",
    "AXMenuBar",
    "AXSecureTextField"
  ]
  let windowPosition = accessibilityPoint(
    window,
    kAXPositionAttribute as CFString
  )
  let windowSize = accessibilitySize(
    window,
    kAXSizeAttribute as CFString
  )
  let shouldFilterHorizontally =
    contentStartRatio > 0.01 || contentEndRatio < 0.99
  var stack: [(AXUIElement, Int)] = [(root, 0)]
  var lines: [String] = []
  var nodeCount = 0
  var truncated = false
  var textLength = 0
  var programmingLanguage: String?

  while let (element, depth) = stack.popLast() {
    nodeCount += 1
    if nodeCount > 12_000 || textLength > 120_000 {
      truncated = true
      break
    }
    if depth > 80 {
      truncated = true
      continue
    }
    let role = accessibilityString(
      element,
      kAXRoleAttribute as CFString
    ) ?? ""
    if skippedRoles.contains(role) {
      continue
    }

    if role == "AXPopUpButton" && programmingLanguage == nil {
      let value = accessibilityString(
        element,
        kAXValueAttribute as CFString
      )
      let title = accessibilityString(
        element,
        kAXTitleAttribute as CFString
      )
      let description = accessibilityString(
        element,
        kAXDescriptionAttribute as CFString
      )
      for candidate in [value, title, description].compactMap({ $0 }) {
        if let language = normalizedProgrammingLanguage(candidate) {
          programmingLanguage = language
          break
        }
      }
    }

    var insideContentBand = true
    if
      shouldFilterHorizontally,
      let windowPosition,
      let windowSize,
      windowSize.width > 0,
      let elementPosition = accessibilityPoint(
        element,
        kAXPositionAttribute as CFString
      )
    {
      let relativeX =
        Double(elementPosition.x - windowPosition.x) /
        Double(windowSize.width)
      if relativeX >= -0.08 && relativeX <= 1.08 {
        insideContentBand =
          relativeX >= contentStartRatio - 0.03 &&
          relativeX <= contentEndRatio + 0.01
      }
    }

    if textRoles.contains(role) && insideContentBand {
      let value = accessibilityString(
        element,
        kAXValueAttribute as CFString
      )
      let title = accessibilityString(
        element,
        kAXTitleAttribute as CFString
      )
      let description = accessibilityString(
        element,
        kAXDescriptionAttribute as CFString
      )
      let text =
        (value?.isEmpty == false ? value : nil) ??
        (title?.isEmpty == false ? title : nil) ??
        (description?.isEmpty == false ? description : nil)
      if
        let text,
        !text.isEmpty,
        lines.last != text
      {
        lines.append(text)
        textLength += text.count
      }
    }

    for child in accessibilityChildren(element).reversed() {
      stack.append((child, depth + 1))
    }
  }

  return AccessibilityTextResult(
    text: lines.joined(separator: "\n"),
    lineCount: lines.count,
    nodeCount: nodeCount,
    truncated: truncated,
    programmingLanguage: programmingLanguage,
    engine: "macos-accessibility"
  )
}

if CommandLine.arguments.contains("--accessibility-text") {
  guard AXIsProcessTrusted() else {
    fail("Accessibility permission is not granted")
  }
  guard
    let processIdValue = argumentValue(prefix: "--pid="),
    let processId = Int32(processIdValue)
  else {
    fail("Accessibility target process id is missing")
  }
  let targetTitle: String
  if
    let encodedTitle = argumentValue(prefix: "--window-title-base64="),
    let titleData = Data(base64Encoded: encodedTitle),
    let decodedTitle = String(data: titleData, encoding: .utf8)
  {
    targetTitle = decodedTitle
  } else {
    targetTitle = ""
  }
  let contentStartRatio = min(
    1,
    max(
      0,
      Double(argumentValue(prefix: "--content-start=") ?? "") ?? 0
    )
  )
  let contentEndRatio = min(
    1,
    max(
      contentStartRatio,
      Double(argumentValue(prefix: "--content-end=") ?? "") ?? 1
    )
  )
  let application = AXUIElementCreateApplication(processId)
  guard
    let window = matchingWindow(
      application: application,
      targetTitle: targetTitle
    )
  else {
    fail("Unable to locate the locked Accessibility window")
  }
  let root =
    matchingWebArea(root: window, targetTitle: targetTitle) ?? window
  let result = accessibilityText(
    root: root,
    window: window,
    contentStartRatio: contentStartRatio,
    contentEndRatio: contentEndRatio
  )
  guard !result.text.isEmpty else {
    fail("Accessibility tree did not expose readable text")
  }
  do {
    FileHandle.standardOutput.write(try JSONEncoder().encode(result))
    exit(0)
  } catch {
    fail("Unable to encode Accessibility text: \(error.localizedDescription)")
  }
}

if CommandLine.arguments.contains("--frontmost-window") {
  let excludedProcessId = CommandLine.arguments
    .first(where: { $0.hasPrefix("--exclude-pid=") })
    .flatMap { Int32($0.replacingOccurrences(of: "--exclude-pid=", with: "")) }
  let frontmostApplication = NSWorkspace.shared.frontmostApplication
  let frontmostProcessId =
    frontmostApplication?.processIdentifier == excludedProcessId
      ? nil
      : frontmostApplication?.processIdentifier
  guard
    let windowList = CGWindowListCopyWindowInfo(
      [.optionOnScreenOnly, .excludeDesktopElements],
      kCGNullWindowID
    ) as? [[String: Any]]
  else {
    fail("Unable to enumerate frontmost windows")
  }

  let candidates = windowList.compactMap {
    window -> (
      bounds: CGRect,
      ownerName: String,
      windowName: String,
      processId: Int32,
      windowId: Int,
      area: CGFloat
    )? in
    guard
      let ownerPid = window[kCGWindowOwnerPID as String] as? Int32,
      ownerPid != excludedProcessId,
      frontmostProcessId == nil || ownerPid == frontmostProcessId,
      let windowId = window[kCGWindowNumber as String] as? Int,
      let layer = window[kCGWindowLayer as String] as? Int,
      layer == 0,
      let boundsDictionary = window[kCGWindowBounds as String] as? NSDictionary,
      let bounds = CGRect(
        dictionaryRepresentation: boundsDictionary as CFDictionary
      ),
      bounds.width >= 240,
      bounds.height >= 160
    else {
      return nil
    }
    let alpha = window[kCGWindowAlpha as String] as? Double ?? 1
    guard alpha > 0 else {
      return nil
    }
    return (
      bounds: bounds,
      ownerName: window[kCGWindowOwnerName as String] as? String
        ?? frontmostApplication?.localizedName
        ?? "",
      windowName: window[kCGWindowName as String] as? String ?? "",
      processId: ownerPid,
      windowId: windowId,
      area: bounds.width * bounds.height
    )
  }

  guard
    let selected =
      frontmostProcessId == nil
        ? candidates.first
        : candidates.max(by: { $0.area < $1.area })
  else {
    fail("No capturable frontmost window was found")
  }
  let result = FrontmostWindowResult(
    windowId: selected.windowId,
    x: Double(selected.bounds.minX),
    y: Double(selected.bounds.minY),
    width: Double(selected.bounds.width),
    height: Double(selected.bounds.height),
    ownerName: selected.ownerName,
    windowName: selected.windowName,
    processId: selected.processId
  )
  do {
    FileHandle.standardOutput.write(try JSONEncoder().encode(result))
    exit(0)
  } catch {
    fail("Unable to encode frontmost window: \(error.localizedDescription)")
  }
}

let imageData = FileHandle.standardInput.readDataToEndOfFile()
guard !imageData.isEmpty else {
  fail("OCR image data is empty")
}

guard
  let source = CGImageSourceCreateWithData(imageData as CFData, nil),
  let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
else {
  fail("Unable to decode OCR image")
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = false
request.minimumTextHeight = 0.006

let handler = VNImageRequestHandler(cgImage: image, options: [:])
do {
  try handler.perform([request])
} catch {
  // 某些系统版本没有预装中文 accurate 模型。先保留 accurate 级别回退到
  // 系统默认语言，再在最后回退到无需语言模型的 fast 识别。
  request.recognitionLanguages = []
  request.usesLanguageCorrection = false
  do {
    try handler.perform([request])
  } catch {
    request.recognitionLevel = .fast
    do {
      try handler.perform([request])
    } catch {
      fail("Vision OCR failed: \(error.localizedDescription)")
    }
  }
}

let observations = request.results ?? []
let lines = observations.compactMap { observation -> RecognizedLine? in
  guard let candidate = observation.topCandidates(1).first else {
    return nil
  }
  let box = observation.boundingBox
  return RecognizedLine(
    text: candidate.string,
    confidence: Double(candidate.confidence) * 100,
    boundingBox: BoundingBox(
      x: box.minX,
      y: 1 - box.maxY,
      width: box.width,
      height: box.height
    )
  )
}.sorted { left, right in
  let verticalDifference = left.boundingBox.y - right.boundingBox.y
  if abs(verticalDifference) > 0.012 {
    return verticalDifference < 0
  }
  return left.boundingBox.x < right.boundingBox.x
}

let weightedConfidence = lines.reduce((total: 0.0, weight: 0.0)) { partial, line in
  let weight = Double(max(1, line.text.count))
  return (
    total: partial.total + line.confidence * weight,
    weight: partial.weight + weight
  )
}
let confidence =
  weightedConfidence.weight > 0
    ? weightedConfidence.total / weightedConfidence.weight
    : 0
let result = RecognitionResult(
  text: lines.map(\.text).joined(separator: "\n"),
  confidence: confidence,
  lines: lines,
  engine: "apple-vision"
)

do {
  let output = try JSONEncoder().encode(result)
  FileHandle.standardOutput.write(output)
} catch {
  fail("Unable to encode OCR result: \(error.localizedDescription)")
}
