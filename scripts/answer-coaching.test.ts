import test from 'node:test'
import assert from 'node:assert/strict'
import { answerCoachingInstructions, findAnswerCoachingIssues, findChineseSpokenStyleIssues } from '../src/shared/answer-coaching'
import { DEFAULT_CONFIG, createEmptySessionPreset } from '../src/shared/types'
import { buildAnswerMessages } from '../src/renderer/src/services/question-detector'
import { buildReviewMessages, findAnswerDepthIssues, reviewAnswer } from '../src/renderer/src/services/answer-quality'
import { buildConsistencyInstructions } from '../src/renderer/src/services/answer-strategy'
import { normalizeSessionPreset, relevantDocumentChunks, buildSessionPresetInstructions } from '../src/renderer/src/services/session-preset'

const model = { ...DEFAULT_CONFIG.llm, apiKey: 'unit-test', baseURL: 'https://test.invalid/v1', model: 'unit-test' }
const roleAnswer = '在 Synora 的采购分析里，我重点处理模型解释与原始数量的对应关系。服务端先计算缺口，再把结果交给模型组织说明。我会按物料、期间和单位核对关键数字，识别把缺货解释成充足的语义错误。出现偏差时回退到确定性摘要，并把这类输入加入回归测试。这样把模型的解释能力与业务数据校验结合起来。'

test('audit voice examples are caught without banning technical negation', () => {
  for (const value of [
    '目前无法核实我在 Synora 中具体负责了哪些工作，所以不能证明项目是我自己做的。',
    '目前没有足够公开信息确认，不能把推测说成内部事实。',
    '当前 Synora 的项目证据不足以支持一个具体的第一人称案例，我不会补写经历。',
    "I cannot verify my role in this project."
  ]) assert.ok(findAnswerCoachingIssues(value).length > 0, value)
  for (const value of [roleAnswer, '没有审批时，服务端拒绝写入。库存缺失时保留待核验状态。', '未经授权不能读取其他企业的数据。']) {
    assert.equal(findAnswerCoachingIssues(value).length, 0)
  }
})

test('generation identifies I as the user and excludes rejected audit answers from history', () => {
  const rejected = '目前无法核实我在 Synora 负责哪些工作。'
  const messages = buildAnswerMessages('你负责哪些工作？', [], [{id:'qa1',question:'介绍项目',answer:rejected,timestamp:1,mode:'normal'}] as any, 'AI应用工程师', 'normal', 'zh', 'Synora 是我独立完成的项目。')
  assert.ok(messages[0].content.includes('“我”始终指用户'))
  assert.ok(messages[0].content.includes('本人项目'))
  assert.ok(messages[0].content.includes('专业度、具体性和说服力'))
  assert.equal(messages.some(message => message.role === 'assistant' && message.content === rejected), false)
  const consistency = buildConsistencyInstructions('same', [{id:'qa1',question:'介绍项目',answer:rejected,questionClusterId:'same'}] as any, [], 'zh')
  assert.equal(consistency, '')
  assert.ok(answerCoachingInstructions(false).includes('"I" means the user'))
})

test('Chinese project scenarios count sentences without requiring spaces after punctuation', () => {
  assert.deepEqual(findAnswerDepthIssues('请举一个项目场景', roleAnswer, 'project-scenario'), [])
})

test('QA review uses answer optimization; Mentor retains code/sample validation', () => {
  const qa = buildReviewMessages({llmConfig:model,scope:'qa',subject:'我做了哪些工作',draftAnswer:roleAnswer,responseLanguage:'zh'})
  assert.ok(qa[0].content.includes("professional answer editor"))
  assert.ok(qa[0].content.includes('Source files need not repeat'))
  assert.equal(qa[0].content.includes('make finalAnswer clearly state what cannot be determined'), false)
  const mentor = buildReviewMessages({llmConfig:model,scope:'mentor',subject:'算法题',draftAnswer:'code',responseLanguage:'zh'})
  assert.ok(mentor[0].content.includes('A single mismatch requires'))
})

test('review repairs third-person auditing rather than rejecting the user contribution', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    const finalAnswer = calls === 1 ? '无法核实我在项目里负责了什么。' : roleAnswer
    return Response.json({choices:[{message:{content:JSON.stringify({verdict:'corrected',confidence:'medium',finalAnswer,note:'表达优化',sampleValidation:[]})}}]})
  }) as typeof fetch
  try {
    const review = await reviewAnswer({llmConfig:model,scope:'qa',subject:'你负责了什么',draftAnswer:roleAnswer,responseLanguage:'zh',answerStrategy:'project-scenario'})
    assert.equal(calls, 2)
    assert.equal(review.finalAnswer, roleAnswer)
    assert.equal(findAnswerCoachingIssues(review.finalAnswer).length, 0)
  } finally { globalThis.fetch = original }
})

test('failed rewriting preserves a useful draft and never injects a canned refusal', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => Response.json({choices:[{message:{content:JSON.stringify({verdict:'insufficient',confidence:'low',finalAnswer:'当前资料不足以支持第一人称案例，我不会补写经历。',note:'test',sampleValidation:[]})}}]})) as typeof fetch
  try {
    const review = await reviewAnswer({llmConfig:model,scope:'qa',subject:'案例',draftAnswer:roleAnswer,responseLanguage:'zh',answerStrategy:'project-scenario'})
    assert.equal(review.finalAnswer, roleAnswer)
  } finally { globalThis.fetch = original }
})

test('full imported documents survive 80k and tail sections remain searchable', () => {
  const text = '# 学习手册\n' + '常规业务材料与背景介绍。\n'.repeat(8000) + '\n## 结果验收\n反事实测试通过改变企业身份检查权限隔离，变形测试检查等价输入输出一致。最终业务状态必须核对真实回执。'
  const preset = normalizeSessionPreset({...createEmptySessionPreset(),documents:[{name:'手册.md',text}]})
  assert.equal(preset.documents[0].text, text)
  assert.equal(preset.documents[0].truncated, false)
  const chunks = relevantDocumentChunks(preset,'如何用反事实与变形测试验收报告？', false)
  assert.ok(chunks.some(chunk => chunk.text.includes('反事实测试通过改变企业身份')))
  assert.ok(chunks.some(chunk => chunk.heading.includes('结果验收') || chunk.text.includes('## 结果验收')))
})

test('reference retrieval connects bilingual terms and keeps multiple relevant sources', () => {
  const preset = normalizeSessionPreset({...createEmptySessionPreset(),topic:'采购系统的通用背景',documents:[
    {name:'项目说明.md',text:'# 采购分析\n模型生成采购报告，服务端按物料和企业校验输入及权限。'},
    {name:'面试手册.md',text:'# 能力边界\n## Hallucination governance\nClaim-to-evidence mapping checks groundedness. Cross-check claims against source facts and use regression evaluation.'},
    {name:'无关.md',text:'# 团建\n周末活动安排与餐饮地点。'}
  ]})
  const instructions = buildSessionPresetInstructions(preset,'采购报告中的模型幻觉如何治理？')
  assert.ok(instructions.includes('groundedness'))
  assert.ok(instructions.includes('项目说明.md'))
  assert.ok(instructions.includes('面试手册.md'))
  assert.equal(instructions.includes('周末活动安排'), false)
  assert.ok(instructions.includes('两者互补'))
})

test('review receives the same references in a separate block even with a long repository context', () => {
  const marker = 'REFERENCE_TAIL_RETAINED'
  const references = '已选取的手册片段：'+ '技术方法与验收要求。'.repeat(3500) + marker
  const messages = buildReviewMessages({llmConfig:model,scope:'qa',subject:'设计评测',draftAnswer:roleAnswer,evidence:'仓库资料。'.repeat(10000),referenceInstructions:references,responseLanguage:'zh'})
  assert.ok(messages[1].content.includes(marker))
  assert.ok(messages[1].content.includes('<session_reference_material>'))
})


test('Chinese spoken checks flag report habits, not legitimate technical vocabulary', () => {
  for (const value of [
    '综上所述，通过多维度协同形成闭环，赋能业务。',
    '在事实层面检查来源，在权限层面检查授权，在执行层面检查状态。',
    '针对采购分析过程中出现的多种复杂异常情况，我通过统一的业务状态管理、细粒度权限控制、确定性规则计算、完整的事实引用核验以及跨组件调用追踪，将多个不同环节中的数据读取结果和执行状态组织起来，同时结合业务编号以及后端返回的回执进行比对，以实现整个采购分析业务流程中各个环节的状态一致性保障。',
    '嗯，嗯，嗯，我检查权限。'
  ]) assert.ok(findChineseSpokenStyleIssues(value).length > 0, value)
  for (const value of [
    '这里我会先查订单状态，因为超时不代表下单失败。查到已经建好了，就返回原结果，避免重复下单。',
    '幂等就是同一个请求重复到达，业务上只执行一次。比如下单时我会带上业务编号，后端先查它有没有处理过。',
    '我把采购单号传给 API，然后核对 ERP 回执。',
    '```ts\n// 综上所述\nconst closedLoop = true\n```',
    '先核对企业身份，再检查权限，最后看回执。'
  ]) assert.deepEqual(findChineseSpokenStyleIssues(value), [], value)
})

test('Chinese generation and review share functional spoken guidance without filler quotas', () => {
  const messages = buildAnswerMessages('为什么用多模型？', [], [], '工程师', 'normal', 'zh')
  const review = buildReviewMessages({llmConfig:model,scope:'qa',subject:'为什么用多模型？',draftAnswer:roleAnswer,responseLanguage:'zh'})
  for (const prompt of [messages[0].content, review[0].content]) {
    assert.ok(prompt.includes('面试口头表达要求'))
    assert.ok(prompt.includes('连接语要有作用'))
    assert.ok(prompt.includes('不逐句硬加'))
    assert.ok(prompt.includes('口头：“'))
    assert.ok(prompt.includes('技术含义仍要讲明白'))
  }
  assert.ok(review[0].content.includes('参考材料提供知识和事实'))
  assert.equal(messages[0].content.includes('15–30'), false)
})

test('Chinese QA review rewrites report voice while preserving useful project content', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async (_input, init) => {
    calls++
    if (calls === 2) {
      const body = JSON.parse(String(init?.body))
      assert.ok(body.messages[0].content.includes('空泛总结或宣传套话'))
    }
    const finalAnswer = calls === 1 ? roleAnswer + '综上所述，这形成闭环。' : roleAnswer
    return Response.json({choices:[{message:{content:JSON.stringify({verdict:'corrected',confidence:'high',finalAnswer,sampleValidation:[]})}}]})
  }) as typeof fetch
  try {
    const result = await reviewAnswer({llmConfig:model,scope:'qa',subject:'采购分析怎么做？',draftAnswer:roleAnswer,responseLanguage:'zh'})
    assert.equal(calls, 2)
    assert.equal(result.finalAnswer, roleAnswer)
  } finally { globalThis.fetch = original }
})
