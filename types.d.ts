/**
 * 仅用于 `tsc --noEmit` 静态检查的类型声明，不会被扩展加载，也不产生任何运行时产物。
 */

/** 旧版 provider 类型标识，只为 `getProviderType()` 兼容入口保留 */
export type ProviderTypeId = 'openai' | 'deepl';

export type ProtocolId =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-gemini'
  | 'deepl'
  | 'microsoft-edge'
  | 'microsoft-azure'
  | 'google-free'
  /** NVIDIA Riva Translate：专用 MT，system 只发语言对标签 */
  | 'nvidia-riva';

export type EnforcementMode = 'fallback' | 'repair' | 'warn';
export type DisplayMode = 'translation' | 'bilingual';
/** 翻译范围：视口优先（滚动续翻）或一次性整页 */
export type TranslateScope = 'viewport' | 'whole';


export interface ModelsCache {
  at: number;
  list: string[];
  /** 产生这份缓存的 URL；baseUrl/modelsUrl 变了就失效 */
  forUrl: string;
}

export interface ProviderConfig {
  id: string;
  presetId: string;
  protocol: ProtocolId;
  label?: string;
  baseUrl?: string;
  /** 可选覆盖；留空时按预设或 baseUrl 推导 */
  modelsUrl?: string;
  model?: string;
  apiKey?: string;
  /** 仅 Azure Translator：区域资源必填，global 可空 */
  region?: string;
  /** 仅 NVIDIA Riva：源语言 id（默认 en），用于拼语言对标签 */
  sourceLang?: string;
  modelsCache?: ModelsCache;
  /** 仅旧配置迁移时短暂存在，迁移后删除 */
  type?: 'openai' | 'deepl';
}

export interface GlossarySettings {
  useBuiltin: boolean;
  terms: string[];
}

export interface Settings {
  schemaVersion: 2;
  targetLang: string;
  targetLangCode: string;
  activeProviderId: string | null;
  providers: ProviderConfig[];
  displayMode: DisplayMode;
  translateScope: TranslateScope;
  enforcement: EnforcementMode;
  glossary: GlossarySettings;
  /** 可选审校服务：从已配置的 LLM provider 里选；null = 不审校 */
  reviewProviderId: string | null;
  /** 本地调试日志（默认关闭）；只写 chrome.storage.local */
  debugLogEnabled: boolean;
  /** 记录最多 120 字的原文/译文样本（默认关闭，含页面文本） */
  debugLogSamples: boolean;
  /** 每安装一个 UUID；OpenCode Go 的 x-opencode-session 用它 */
  sessionId: string;
}

export interface ReviewOutcome {
  /** 送审的段数 */
  reviewed: number;
  /** 实际替换的段数 */
  corrected: number;
  /** 审校请求失败（主译文保留） */
  failed: boolean;
  /** 可疑段超过上限，只审了前 N 段 */
  truncated: boolean;
}

export interface ReviewItem {
  index: number;
  reasons: string[];
  missing: string[];
}

/** translate 响应里附带的可疑段（只带批次内 index 与原因，不带原文） */
export interface ReviewCandidate extends ReviewItem {}

/** 审校模型返回的单项：index 必须是送审片段里的下标，corrected 非空 */
export interface ReviewCorrection {
  index: number;
  corrected: string;
}

/** content → background 的送审项：id 由 content 生成，background 不解释 */
export interface ReviewRunItem {
  id: string;
  source: string;
  primary: string;
  reasons: string[];
  missing: string[];
  /** 同批内前后各 1 段，只给模型提供语境 */
  prev?: string;
  next?: string;
}

/** 页面级上下文；background 只把域名与类型发给模型 */
export interface ReviewPageContext {
  title?: string;
  url?: string;
  kind?: string;
}

/** 审校响应里的统计（与 ReviewOutcome 同形，避免两套名字漂移） */
export interface ReviewRunResult extends ReviewOutcome {}

/** content 内存里的审校 diff（最多 100 条，不持久化） */
export interface ReviewLogEntry {
  id: string;
  source: string;
  primary: string;
  corrected: string | null;
  reasons: string[];
  applied: boolean;
  rejectedReason: string | null;
}

/** page.status.review */
export interface ReviewStatus {
  pending: boolean;
  reviewed: number;
  corrected: number;
  failed: boolean;
  truncated: boolean;
}

/** 背景把模型 index 映射回 content 的 id 后返回的条目 */
export interface ReviewIdCorrection {
  id: string;
  corrected: string;
}

/** 背景在二次校验阶段丢弃的修正（带原因，供 diff 展示） */
export interface ReviewRejection {
  id: string;
  reason: string;
}

export type DebugLogLevel = 'info' | 'warn' | 'error';

/** 单条调试日志；写盘前已脱敏、已截断 */
export interface DebugLogEntry {
  v: 1;
  ts: string;
  level: DebugLogLevel;
  event: string;
  source: 'content' | 'background' | 'options' | 'popup';
  tabId?: number;
  url?: string;
  title?: string;
  message?: string;
  data?: Record<string, unknown>;
  note?: string;
}

/** 导出文件结构；settings 是脱敏摘要，不含 key */
export interface DebugLogExport {
  appVersion: string;
  ua: string;
  exportedAt: string;
  samples: boolean;
  settings: Record<string, unknown>;
  entries: DebugLogEntry[];
}


export interface TranslateArgs {
  texts: string[];
  config: ProviderConfig;
  target: string;
  targetCode: string;
  glossary?: string[];
  enforcement?: EnforcementMode;
  /** 由 background 注入；例如 x-opencode-session */
  extraHeaders?: Record<string, string>;
  /** 测试用；默认 [1000, 4000, 10000] */
  retry?: { delays: number[] };
}

export interface TranslateBatchResult {
  translations: string[];
  /** 因术语保护保留原文的段数 */
  protected: number;
  /** 仅 warn 模式：哪些段可能漏了词 */
  warnings: { index: number; missing: string[] }[];
}

export interface ProtocolBuildArgs {
  texts: string[];
  config: ProviderConfig;
  target: string;
  targetCode: string;
  /** 本批注入 prompt 的术语（≤40） */
  terms?: string[];
  extraHeaders?: Record<string, string>;
  jsonMode?: boolean;
  repair?: boolean;
  /** 覆盖默认翻译 system prompt（审校层用） */
  system?: string;
  /** 覆盖默认 `{segments:[...]}` user payload（审校层用） */
  userContent?: string;
}

export interface Protocol {
  id: ProtocolId;
  label: string;
  /** 是否支持 prompt 级术语注入；MT 为 false（DeepL / 微软 / Google 免费接口） */
  supportsGlossary?: boolean;
  /** 从协议响应里取出模型文本（审校层用） */
  extractContent?: (json: any) => string;
  /** 只发请求并返回模型文本；不解析 segments（审校层用） */
  requestContent?: (
    args: ProtocolBuildArgs & { retry?: { delays: number[] } },
  ) => Promise<string>;
  buildRequest: (args: ProtocolBuildArgs) => {
    url: string;
    headers: Record<string, string>;
    body: unknown;
  };
  parseResponse: (json: any) => string[];
  translate: (args: ProtocolBuildArgs & { retry?: { delays: number[] } }) => Promise<string[]>;
}


export interface FieldSpec {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  required?: boolean;
}

export interface ProviderType {
  type: ProviderTypeId;
  label: string;
  hint: string;
  fields: FieldSpec[];
  translate: (args: TranslateArgs) => Promise<string[]>;
}
