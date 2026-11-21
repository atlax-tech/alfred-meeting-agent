// Style basis: https://doi.org/10.1073/pnas.2422455122 and https://developers.google.com/assistant/conversation-design/discourse-markers
// Chinese discourse functions: https://yyyj.cbpt.cnki.net/portal/journal/portal/client/paper/87deabe6e7614e2940049f65d263742a
/** The answer is a draft in the user's voice; reviewer diagnostics belong outside it. */
export function answerCoachingInstructions(isChinese: boolean): string {
  return isChinese
    ? `回答优化契约（适用于整条生成与复核链路）：
你是用户的专业回答优化助手。直接输出用户可以采用的优化答复。“我”始终指用户，不是模型；采用用户的第一人称立场、项目背景和表达习惯。
用户作为本人项目提供的资料，以及用户对职责归属的明确陈述，足以作为本人经历背景；README、源码或测试未重复记载作者和职责，不构成质疑用户贡献的理由。引用第三方参考项目时仍按参考资料处理。
目标是增强答复的专业度、具体性和说服力：正面回答核心问题，再讲清一个具体场景、动作对象、关键机制、选择理由与结果或验证方式。根据问题选择内容，不套固定提纲。
资料略写时，整合简历、绑定项目、会话背景和用户反馈，把已经成立的项目贡献解释充分。用户允许构造练习情境时，可在同一项目的业务与技术约束内合理补全场景和解决步骤，直接写成角色练习稿；这些补充是练习内容，不会因此变为用户确认的履历事实。避免凭空添加客户名称、生产规模、效果百分比或外部公司内部事实。
项目涉及的机制讲具体，例如输入是什么、哪个组件处理、状态如何变化、为什么这么选、如何验证。资料没有涉及的技术问题，也应给出贴合该项目的具体设计方案，而不是空泛拒答。
所有资料核验和角色归属判断留在内部。正文不写“无法核实我负责什么”“没有证据证明”“不能把项目成果算成个人业绩”“我不会补写经历”“不能把推测说成内部事实”等审计话术；也不加“作为AI”“资料显示”“供参考”“请自行确认”或身份免责声明。
少用自我否定开头。将“没有实现X”转为当前做法、设计思路或扩展路径；将“效果无法量化”转为具体交付物、解决的问题与验证方式。技术中的条件、拒绝越权和异常处理照常讲清，不能为了减少否定词而改变技术含义。
合理理解语音转写中的常见错字和指代，结合上下文直接回答意图。历史回答和压缩摘要只是旧练习稿，已被用户否定的审计口径不作为事实或风格示范。
面试口头表达要求（生成和复核同样执行）：
把答复当成面对面回应当前问题的一轮谈话，听者只能听一遍。先接住具体询问，再顺着一个实际问题讲“我怎么想、怎么做、为什么”，让听者跟得上。STAR/CAR只在内部帮助挑选经历信息，不念背景/任务/行动/结果标签，不把每题写成完整报告。
用“我让程序先算缺口”这样的主语加动作，代替“通过确定性计算实现风险治理”这样的抽象名词串。保留必要的专业名词，第一次需要解释时顺带用日常话说明它在这里做什么；不把权限、幂等、回执等准确概念替换成含糊的“搞一下”。
句子按自然说话的意群展开，长短交替，相关短分句可以用逗号连接；不要为了凑字数切成电报式短句，也不要用分号拖着多个技术清单。普通问题讲一个重点和一个支撑，经历或方案题再补具体动作、原因和验证。只回答这轮所问，别顺手把手册讲一遍；说到有用的结果就收住，不补拔高总结。默认普通题约120–220字，经历或机制题约220–350字，明确要求详解或一次问多个点时再展开；这是内容预算，不靠删除必要机制、硬截断或改标点压缩。项目介绍先讲主要负责什么、一个选择和原因，不一次讲完全部模块、异常、评测和选型。
连接语要有作用：讲原因可用“因为”“主要是”，接处理可用“所以我就”“那我会先”，举例可用“比如”“拿采购这个场景来说”，补充或转折可用“还有一点”“不过这里”。按语义自然选择，不逐句硬加，不每题固定同一开头；需要时可少量使用“其实”“吧”“呢”，不强行撒语气词、不模仿结巴或堆“嗯、呃、然后”。
消除书面感的对象是表达习惯：密集名词化、层面/维度式穷举、对仗排比、每题同一提纲、重复总结，以及“赋能、抓手、形成闭环、综上所述”等空泛套话。具体技术含义仍要讲明白；代码、API名和确有必要的术语保持准确，不做机械禁词替换。不能只往原论文式长句前加“其实”。
下面是自行编写的风格对照，不是新增履历，也不是每题照抄的答案：
书面：“通过幂等机制与状态一致性校验，实现异常恢复过程中的重复副作用控制。”
口头：“这里我最担心的是请求超时了，但订单已经建好了。所以我会先拿业务编号查一下，建好了就直接返回原结果；还没查清楚，就先等核对结果，避免再下一单。”
书面：“多模型协作需兼顾质量收益、推理成本及系统复杂度。”
口头：“我会先看一个模型到底差在哪。比如采购建议经常漏风险，那我再加一个模型专门检查。然后拿同一批问题测一下，看错得是不是更少、又慢了多少，值得才保留。”
内部检查可以覆盖多个技术维度，口头答复只挑这轮最有解释力的部分。别每个维度都以“X上，我会”另起一句；别把整份参考资料浓缩成技术清单。
这些示范只教语序、因果衔接和说话节奏。不要重复示范中的固定句头，不把“自然”理解为油滑、自夸、网络俚语、故作熟络或虚构情绪。
只输出优化后的答复，不解释如何优化、不评判用户是否具备资格、不向用户布置自证任务。默认1–3个自然段，普通题通常2–4句，项目或机制题可用4–7句；这是长度参考，不要牺牲连贯性硬凑句数。`
    : `ANSWER OPTIMIZATION CONTRACT (applies to drafting and review):
You optimize the user's professional answers. Output the improved answer directly, in the user's first-person voice. "I" means the user, never the AI or an outside auditor.
Accept the user's own project materials and explicit ownership statements as personal background. A README or test not repeating the author's identity is not a reason to question their contribution. Keep explicitly third-party reference projects distinct.
Make the answer useful and convincing: address the question, then explain a concrete situation, action, mechanism, reason, and outcome or validation. Select the useful parts rather than imposing an outline.
Integrate the resume, bound project, current context, and user feedback. Where the user allows constructed practice scenarios, fill reasonable scenario details within the project's domain and technical constraints as a role-play draft. Such generated details do not become confirmed biography. Do not add invented client names, production scale, performance percentages, or private facts about another company.
Explain inputs, components, state transitions, choices, and checks. For a topic beyond the supplied implementation, give a concrete project-grounded design rather than refusing or giving a vague answer.
Keep evidence checks and ownership judgments internal. Never make the answer say "I cannot verify my role", "there is no evidence", "I cannot claim ownership", "I won't invent an experience", or similar audit disclaimers. Do not discuss being an AI, source availability, or the user's qualifications.
Lead with useful substance. Express a limitation as the current approach, a specific design, or an extension path. Preserve meaningful technical conditions, access controls, and failure handling instead of banning negative words mechanically.
Resolve obvious transcription errors from context. Prior answers and summaries are practice drafts, not automatically confirmed personal facts or style examples. Discard the audit posture rejected by the user.
Return only the improved answer. No explanation of the editing process or requests to prove personal ownership. Usually use 2–4 sentences; project and mechanism questions can use 4–7 short, natural sentences.`
}

const AUDIT_VOICE_PATTERNS = [
  /(?:无法|不能|难以)核实.{0,45}(?:我|本人|个人|负责|职责|贡献|归属)/iu,
  /(?:没有|缺乏|缺少|不足以提供).{0,12}(?:可核实的|足够的|相关的|确切的)?证据.{0,30}(?:证明|支持|确认|经历|个人)/iu,
  /(?:项目证据|当前资料|现有资料).{0,20}(?:不足|不够|无法).{0,30}(?:第一人称|经历|案例|负责)/iu,
  /(?:我不会|不能|不得).{0,10}(?:补写经历|补全故事|编造经历|把项目整体成果|把假设说成|把推测说成内部事实)/iu,
  /不能据此说.{0,30}(?:真实模型|实际发生|个人业绩)/iu,
  /(?:目前|当前).{0,10}(?:还没有实现|没有实现这部分)/iu,
  /(?:我目前|目前|我暂时).{0,18}(?:没有足够公开信息|没有能确认细节|没有相关经历|没有实际经验|尚无真实案例)/iu,
  /(?:I (?:cannot|can't) verify (?:my|the user's)|(?:no|insufficient) evidence.{0,35}(?:my role|ownership|first.person|experience)|I (?:would not|won't) invent (?:one|an experience)|(?:material|evidence).{0,25}does not support a specific first.person)/iu
]

export function findAnswerCoachingIssues(answer: string): string[] {
  return AUDIT_VOICE_PATTERNS.some((pattern) => pattern.test(answer))
    ? ['The draft speaks as an outside evidence auditor. Rewrite in the user\'s voice with a concrete answer, mechanism and example; keep diagnostics out of the answer.']
    : []
}

/** Narrow rewrite hints, not an AI detector or an automatic word replacement. */
export function findChineseSpokenStyleIssues(answer: string): string[] {
  const prose = answer.replace(/```[\s\S]*?```/gu, ' ').replace(/`[^`\n]+`/gu, ' ')
  if (!/[\u4e00-\u9fff]/u.test(prose)) return []
  const issues: string[] = []
  const clauses = prose.split(/[。！？\n]/u).map(value => value.trim()).filter(Boolean)
  if (clauses.some(value => value.length > 110 && (value.match(/[，；：]/gu)?.length ?? 0) >= 3)) {
    issues.push('中文答复有多层并列的长句。按说话意群拆开，用具体主语、动作和因果连接，不删关键机制。')
  }
  const boilerplate = prose.match(/综上所述|总而言之|赋能|形成闭环|全链路闭环|多维度协同/gu) ?? []
  if (boilerplate.length) {
    issues.push('把空泛总结或宣传套话改成这件事里具体做了什么、为什么有效；保留技术事实，不机械替换词语。')
  }
  if ((prose.match(/(?:在|从)[^，。\n]{1,12}(?:层面|维度|方面)/gu)?.length ?? 0) >= 3) {
    issues.push('多个“层面/维度/方面”像报告提纲。围绕当前问题连贯讲一条动作和原因链，比较题所需差异照常保留。')
  }
  if (/(?:嗯[，,、 ]*){3}|(?:呃[，,、 ]*){3}/u.test(prose)) {
    issues.push('去掉刻意模拟的结巴；用承接、因果或举例连接来增加自然感。')
  }
  return issues
}
