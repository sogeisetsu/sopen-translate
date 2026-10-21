/**
 * 仅用于 `tsc --noEmit` 静态检查的类型声明，不会被扩展加载，也不产生任何运行时产物。
 */

export type ProviderTypeId = 'openai' | 'deepl';

export interface ProviderConfig {
  id: string;
  type: ProviderTypeId;
  label?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export interface Settings {
  targetLang: string;
  targetLangCode: string;
  activeProviderId: string | null;
  providers: ProviderConfig[];
}

export interface TranslateArgs {
  texts: string[];
  config: ProviderConfig;
  target: string;
  targetCode: string;
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
