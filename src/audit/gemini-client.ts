// SPDX-License-Identifier: GPL-3.0-only
import { GoogleGenAI, type ThinkingConfig } from '@google/genai';
import { geminiResponseJsonSchema } from './schema.js';

export type GenerateReviewInput = {
  systemPrompt: string;
  userPrompt: string;
};

export type GenerateReviewResult = {
  text: string;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
};

export type GeminiClient = {
  readonly modelId: string;
  generate: (input: GenerateReviewInput) => Promise<GenerateReviewResult>;
};

export type ThinkingConfigInput = {
  thinkingBudget: number;
  thinkingLevel: string;
};

/** 2.5 uses thinkingBudget; 3.x uses thinkingLevel. GA has MINIMAL, not OFF. */
function jsonSchemaWithoutMeta(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return schema;
  }
  const { $schema: _schema, ...rest } = schema as Record<string, unknown>;
  return rest;
}

export function thinkingConfigForModel(model: string, opts: ThinkingConfigInput): ThinkingConfig {
  const id = model.toLowerCase();
  if (id.includes('2.5')) {
    return { thinkingBudget: opts.thinkingBudget };
  }
  const thinkingLevel = opts.thinkingLevel as NonNullable<ThinkingConfig['thinkingLevel']>;
  return { thinkingLevel };
}

export type CreateGeminiClientOptions = {
  model: string;
  project: string;
  location: string;
  thinkingBudget: number;
  thinkingLevel: string;
  temperature: number;
  maxOutputTokens: number;
  apiKey?: string;
};

export function createGeminiClient(opts: CreateGeminiClientOptions): GeminiClient {
  let inner: GoogleGenAI | undefined;
  const getAi = (): GoogleGenAI => {
    if (inner !== undefined) {
      return inner;
    }
    inner =
      opts.apiKey !== undefined && opts.apiKey.length > 0
        ? new GoogleGenAI({ apiKey: opts.apiKey })
        : new GoogleGenAI({
            vertexai: true,
            project: opts.project,
            location: opts.location,
          });
    return inner;
  };

  return {
    modelId: opts.model,
    async generate(input: GenerateReviewInput): Promise<GenerateReviewResult> {
      const response = await getAi().models.generateContent({
        model: opts.model,
        contents: input.userPrompt,
        config: {
          temperature: opts.temperature,
          maxOutputTokens: opts.maxOutputTokens,
          responseMimeType: 'application/json',
          responseJsonSchema: jsonSchemaWithoutMeta(geminiResponseJsonSchema),
          thinkingConfig: thinkingConfigForModel(opts.model, {
            thinkingBudget: opts.thinkingBudget,
            thinkingLevel: opts.thinkingLevel,
          }),
          systemInstruction: input.systemPrompt,
        },
      });
      const usage = response.usageMetadata;
      const result: GenerateReviewResult = {
        text: response.text ?? '',
      };
      if (typeof usage?.promptTokenCount === 'number') {
        result.promptTokenCount = usage.promptTokenCount;
      }
      if (typeof usage?.candidatesTokenCount === 'number') {
        result.candidatesTokenCount = usage.candidatesTokenCount;
      }
      if (typeof usage?.thoughtsTokenCount === 'number') {
        result.thoughtsTokenCount = usage.thoughtsTokenCount;
      }
      return result;
    },
  };
}

export function estimateGeminiCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const id = model.toLowerCase();
  let inputPerM: number | undefined;
  let outputPerM: number | undefined;
  if (id.includes('3.5-flash') && !id.includes('lite')) {
    inputPerM = 1.5;
    outputPerM = 9.0;
  } else if (id.includes('3.1-flash-lite')) {
    inputPerM = 0.25;
    outputPerM = 1.5;
  }
  if (inputPerM === undefined || outputPerM === undefined) {
    return null;
  }
  return (inputTokens / 1_000_000) * inputPerM + (outputTokens / 1_000_000) * outputPerM;
}
