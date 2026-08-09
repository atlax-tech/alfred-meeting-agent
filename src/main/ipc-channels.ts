/**
 * IPC 通道定义
 */

export const IPC = {
  // 配置
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  // 个人认知—表达画像
  PERSONALIZATION_GET: 'personalization:get',
  PERSONALIZATION_SET: 'personalization:set',
  PERSONALIZATION_VERSIONS: 'personalization:versions',
  PERSONALIZATION_ROLLBACK: 'personalization:rollback',
  PERSONALIZATION_EVIDENCE_GET: 'personalization:evidence-get',
  PERSONALIZATION_EVIDENCE_UPSERT: 'personalization:evidence-upsert',
  PERSONALIZATION_EVIDENCE_MARK: 'personalization:evidence-mark',
  KNOWLEDGE_BASE_SELECT: 'knowledge-base:select',
  KNOWLEDGE_BASE_READ: 'knowledge-base:read',
  MEETING_NOTE_SAVE: 'meeting-note:save',
  MEETING_KNOWLEDGE_MAINTAIN: 'meeting-knowledge:maintain',
  // 窗口显示偏好
  STEALTH_UPDATE: 'stealth:update',
  STEALTH_GET: 'stealth:get',
  // 窗口控制
  WIN_MINIMIZE: 'win:minimize',
  WIN_CLOSE: 'win:close',
  APP_QUIT: 'app:quit',
  WIN_TOGGLE_ALWAYS_ON_TOP: 'win:toggle-always-on-top',
  WIN_RESIZE: 'win:resize',
  // 设置面板焦点管理(专注模式开启时,设置面板需临时恢复可聚焦)
  SETTINGS_OPEN: 'settings:open',
  SETTINGS_CLOSE: 'settings:close',
  // 其他文本输入区焦点管理（反馈、历史搜索等）
  INPUT_FOCUS_ACQUIRE: 'input-focus:acquire',
  INPUT_FOCUS_RELEASE: 'input-focus:release',
  // 系统音频源(用于采集腾讯会议/飞书等对方声音)
  SYSTEM_AUDIO_SOURCES: 'system-audio:sources',
  SYSTEM_AUDIO_PERMISSION: 'system-audio:permission',
  // electron-audio-loopback 内置 handler；名称必须与插件保持一致。
  LOOPBACK_ENABLE: 'enable-loopback-audio',
  LOOPBACK_DISABLE: 'disable-loopback-audio',
  // 简历文件解析(PDF/TXT → 文本)
  RESUME_PARSE: 'resume:parse',
  // 当前会话参考资料解析(PDF/DOCX/纯文本 → 文本)
  SESSION_DOCUMENT_PARSE: 'session-document:parse',
  // 会前工作仓库知识索引；实时问答只使用已发布快照。
  REPOSITORY_SELECT: 'repository-knowledge:select',
  REPOSITORY_INDEX: 'repository-knowledge:index',
  REPOSITORY_INDEX_CANCEL: 'repository-knowledge:index-cancel',
  REPOSITORY_INDEX_PROGRESS: 'repository-knowledge:index-progress',
  REPOSITORY_LIST: 'repository-knowledge:list',
  REPOSITORY_FRESHNESS: 'repository-knowledge:freshness',
  REPOSITORY_PREWARM: 'repository-knowledge:prewarm',
  REPOSITORY_RETRIEVE: 'repository-knowledge:retrieve',
  REPOSITORY_EVIDENCE: 'repository-knowledge:evidence',
  // 屏幕文字识别助手
  MENTOR_CAPTURE: 'mentor:capture',
  MENTOR_CAPTURE_REQUEST: 'mentor:capture-request',
  MENTOR_FULLSCREEN_CAPTURE_REQUEST: 'mentor:fullscreen-capture-request',
  MENTOR_REGION_CAPTURE_REQUEST: 'mentor:region-capture-request',
  MENTOR_FULLSCREEN_FRAME_REQUEST: 'mentor:fullscreen-frame-request',
  MENTOR_REGION_FRAME_REQUEST: 'mentor:region-frame-request',
  MENTOR_ACCESSIBILITY_TEXT_REQUEST: 'mentor:accessibility-text-request',
  MENTOR_ACCESSIBILITY_PERMISSION_GET:
    'mentor:accessibility-permission-get',
  MENTOR_ACCESSIBILITY_PERMISSION_REQUEST:
    'mentor:accessibility-permission-request',
  MENTOR_VISION_OCR_REQUEST: 'mentor:vision-ocr-request',
  MENTOR_SELECTION_REQUEST: 'mentor:selection-request',
  MENTOR_START_SELECTION: 'mentor:start-selection',
  MENTOR_REGION_SELECTED: 'mentor:region-selected',
  MENTOR_CAPTURE_ERROR: 'mentor:capture-error',
  MENTOR_DELAYED_CAPTURE: 'mentor:delayed-capture',
  MENTOR_CONTINUOUS_CAPTURE: 'mentor:continuous-capture',
  MENTOR_CONTINUOUS_SELECTION: 'mentor:continuous-selection',
  MENTOR_CONTINUOUS_FINISH: 'mentor:continuous-finish',
  MENTOR_CONTINUOUS_UNDO: 'mentor:continuous-undo',
  MENTOR_CONTINUOUS_CANCEL: 'mentor:continuous-cancel',
  MENTOR_TOGGLE_LISTENING: 'mentor:toggle-listening',
  MENTOR_COPY_ANSWER: 'mentor:copy-answer',
  MENTOR_RECHECK_ANSWER: 'mentor:recheck-answer',
  MENTOR_TOGGLE_PANEL: 'mentor:toggle-panel',
  MENTOR_PANEL_OPEN: 'mentor:panel-open',
  MENTOR_PANEL_CLOSE: 'mentor:panel-close'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
