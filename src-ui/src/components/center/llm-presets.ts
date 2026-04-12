// llm-presets.ts — Pre-configured provider templates for LLM translation
// User picks a preset → baseUrl + model auto-filled → user only pastes API key

export interface LLMPreset {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKeyUrl: string;
  free: boolean;
}

export const LLM_PRESETS: LLMPreset[] = [
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen3-8B',
    apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak',
    free: true,
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    apiKeyUrl: 'https://console.groq.com/keys',
    free: true,
  },
  {
    id: 'zhipu',
    name: 'Zhipu GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    free: true,
  },
  {
    id: 'modelscope',
    name: 'ModelScope',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    model: 'Qwen/Qwen2.5-72B-Instruct',
    apiKeyUrl: 'https://www.modelscope.cn/my/myaccesstoken',
    free: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-flash-1.5:free',
    apiKeyUrl: 'https://openrouter.ai/keys',
    free: true,
  },
];
