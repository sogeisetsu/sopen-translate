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
  | 'microsoft-azure';

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
  /** 配了审校服务时的结果；MT（DeepL / 微软）也走这一层 */
  review?: ReviewOutcome;
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
  /** 是否支持 prompt 级术语注入；MT 为 false（DeepL / 微软） */
  supportsGlossary?: boolean;
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
