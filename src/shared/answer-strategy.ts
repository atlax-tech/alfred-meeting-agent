import type { AnswerStrategyKind } from './types'

const STRATEGY_PATTERNS: Array<{
  kind: AnswerStrategyKind
  patterns: RegExp[]
}> = [
  {
    kind: 'project-scenario',
    patterns: [
      /(?:讲讲|说说|描述|分享|举个例子).{0,16}(?:一次|时候|经历|场景|情况)/iu,
      /(?:有没有|是否有过).{0,16}(?:经历|情况|场景)/iu,
      /(?:当时|那次|这种情况下).{0,20}(?:怎么做|做了什么|如何处理|为什么)/iu,
      /(?:实际项目|项目经历|真实经历).{0,20}(?:怎么|如何|例子|案例)/iu,
      /\b(?:tell me about|describe|share|give me an example of)\b.{0,32}\b(?:a time|situation|experience|case)\b/iu,
      /\b(?:have you ever|in your experience|what did you do and why|what did you do next)\b/iu
    ]
  },
  {
    kind: 'project-overview',
    patterns: [
      /(?:介绍|讲讲|概括|说说).{0,10}(?:项目|系统|产品|仓库)/iu,
      /(?:项目|系统|产品|仓库).{0,10}(?:介绍|概览|主要做什么|是做什么|解决什么|用来做什么)/iu,
      /\b(?:introduce|describe|overview|walk me through|tell me about)\b.{0,24}\b(?:project|system|product|repository|repo)\b/iu,
      /\b(?:project|system|product|repository|repo)\b.{0,16}\b(?:overview|introduction|summary|does|about)\b/iu
    ]
  },
  {
    kind: 'comparison',
    patterns: [
      /(?:区别|对比|相比|取舍|选哪个|为什么不用)/iu,
      /\b(?:compare|difference|versus|vs\.?|trade-?off|why not|choose between|choose .{0,20} over)\b/iu
    ]
  },
  {
    kind: 'incident-or-failure',
    patterns: [
      /(?:故障|事故|失败|异常|出错|宕机|回滚|根因|排查|恢复)/iu,
      /\b(?:incident|outage|failure|failed|error|rollback|root cause|debug|recover)\b/iu
    ]
  },
  {
    kind: 'progress-and-result',
    patterns: [
      /(?:进度|结果|效果|指标|上线|交付|完成|产出|收益)/iu,
      /\b(?:progress|result|outcome|metric|measure|launch|ship|deliver|impact)\b/iu
    ]
  },
  {
    kind: 'project-deep-dive',
    patterns: [
      /(?:最难|难点|挑战|关键部分|负责什么|具体做了|主要思路)/iu,
      /\b(?:hardest|challenge|deep dive|your role|what did you do|main idea)\b/iu
    ]
  },
  {
    kind: 'technical-design',
    patterns: [
      /(?:怎么|如何).{0,16}(?:设计|实现|处理|保证|优化|测试|验证)/iu,
      /(?:架构|约束|边界|容错|失败处理|数据流|调用链|性能)/iu,
      /\b(?:design|implement|architecture|constraint|boundary|fallback|failure handling|data flow|performance)\b/iu
    ]
  },
  {
    kind: 'definition',
    patterns: [
      /(?:是什么|什么意思|定义|原理)/iu,
      /\b(?:what is|what does|define|meaning|how does .* work)\b/iu
    ]
  }
]

const GENERIC_WORDS = new Set([
  'about', 'can', 'could', 'describe', 'did', 'does', 'explain', 'how', 'introduce',
  'me', 'please', 'project', 'repository', 'system', 'tell', 'the', 'this', 'walk',
  'what', 'why', 'you', '一下', '为什么', '介绍', '什么', '仓库', '如何', '怎么',
  '系统', '讲讲', '说说', '这个', '项目'
])

function semanticTokens(question: string): string[] {
  const normalized = question.normalize('NFKC').toLocaleLowerCase()
  const tokens = normalized.match(/[a-z0-9_$][a-z0-9_$.-]{1,}|[\p{Script=Han}]{2,}/gu) ?? []
  return [...new Set(tokens.filter((item) => !GENERIC_WORDS.has(item)))].sort()
}

export function resolveAnswerStrategy(question: string): AnswerStrategyKind {
  if (/^(?:which one|what|why|how|怎么|为什么|哪个|哪一个)[?？\s]*$/iu.test(question.trim())) {
    return 'clarification'
  }
  for (const candidate of STRATEGY_PATTERNS) {
    if (candidate.patterns.some((pattern) => pattern.test(question))) return candidate.kind
  }
  return question.trim().length < 6 ? 'clarification' : 'general'
}

export function questionClusterId(
  question: string,
  strategy: AnswerStrategyKind,
  repositorySnapshotId?: string
): string {
  const subject = strategy === 'project-overview'
    ? 'general'
    : semanticTokens(question).slice(0, 6).join(':') || 'general'
  return `${repositorySnapshotId ?? 'no-repository'}:${strategy}:${subject}`
}
