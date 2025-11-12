import { createTool } from '@mastra/core/tools';
import { MCPServer } from '@mastra/mcp';
import { MarkItDown } from 'markitdown-ts';
import { z } from 'zod';

type MarkItDownCommonOptions = {
  enableYoutubeTranscript?: boolean;
  youtubeTranscriptLanguage?: string;
  cleanupExtracted?: boolean;
  styleMap?: string | string[];
};

const markItDown = new MarkItDown();

const OptionsSchema = z.object({
  enableYoutubeTranscript: z
    .boolean()
    .describe('Включить извлечение транскрипта YouTube (если поддерживается).')
    .optional(),
  youtubeTranscriptLanguage: z
    .string()
    .min(2)
    .max(10)
    .describe('Язык транскрипта YouTube (например, "en", "ru").')
    .optional(),
  cleanupExtracted: z
    .boolean()
    .describe('Удалять ли временные файлы при конвертации архивов.')
    .optional(),
  styleMap: z
    .union([z.string(), z.array(z.string())])
    .describe('Дополнительные правила mammoth.js для DOCX.')
    .optional(),
});

const convertOptions = (options: MarkItDownCommonOptions) => {
  const {
    enableYoutubeTranscript,
    youtubeTranscriptLanguage,
    cleanupExtracted,
    styleMap,
  } = options;

  const sanitized: Record<string, unknown> = {};

  if (enableYoutubeTranscript !== undefined) {
    sanitized.enableYoutubeTranscript = enableYoutubeTranscript;
  }

  if (youtubeTranscriptLanguage) {
    sanitized.youtubeTranscriptLanguage = youtubeTranscriptLanguage;
  }

  if (cleanupExtracted !== undefined) {
    sanitized.cleanupExtracted = cleanupExtracted;
  }

  if (styleMap !== undefined) {
    sanitized.styleMap = styleMap;
  }

  return sanitized;
};

export const markItDownConvertSourceTool = createTool({
  id: 'markitdown_convert_source',
  description:
    'Конвертирует файл или URL в Markdown, используя markitdown-ts. Поддерживает PDF, DOCX, PPTX, HTML и другие форматы.',
  inputSchema: OptionsSchema.extend({
    source: z
      .string()
      .min(1)
      .describe('Локальный путь или URL до файла, который нужно преобразовать.'),
  }),
  execute: async ({ context }) => {
    const { source, ...rawOptions } = context;
    const options = convertOptions(rawOptions);
    const result = await markItDown.convert(source, options);

    if (!result) {
      return {
        success: false as const,
        message: 'Не удалось получить содержимое. Проверьте путь или URL источника.',
      };
    }

    return {
      success: true as const,
      title: result.title ?? null,
      markdown: result.text_content,
      characters: result.text_content.length,
    };
  },
});

export const markItDownConvertBufferTool = createTool({
  id: 'markitdown_convert_buffer',
  description:
    'Конвертирует Base64-контент в Markdown с указанием расширения файла. Подходит для загрузок из памяти.',
  inputSchema: OptionsSchema.extend({
    base64Content: z
      .string()
      .min(1)
      .describe('Base64-кодированное содержимое файла (может включать data: URI).'),
    fileExtension: z
      .string()
      .regex(/^\.[a-z0-9]+$/i, 'Укажите расширение вида ".pdf" или ".docx".')
      .describe('Расширение исходного файла, определяющее используемый конвертер.'),
  }),
  execute: async ({ context }) => {
    const { base64Content, fileExtension, ...rawOptions } = context;
    const normalizedBase64 = base64Content.includes(',')
      ? base64Content.slice(base64Content.indexOf(',') + 1)
      : base64Content;
    const buffer = Buffer.from(normalizedBase64, 'base64');
    const options = convertOptions(rawOptions);

    const result = await markItDown.convertBuffer(buffer, {
      ...options,
      file_extension: fileExtension,
    });

    if (!result) {
      return {
        success: false as const,
        message: 'Конвертация вернула пустое значение. Проверьте корректность содержимого.',
      };
    }

    return {
      success: true as const,
      title: result.title ?? null,
      markdown: result.text_content,
      characters: result.text_content.length,
    };
  },
});

export const markItDownMcpServer = new MCPServer({
  id: 'markitdown-mcp-server',
  name: 'MarkItDown',
  version: '1.0.0',
  description:
    'MCP сервер для конвертации документов в Markdown при помощи markitdown-ts. Поддерживает локальные файлы, URL и Base64.',
  tools: {
    markitdown_convert_source: markItDownConvertSourceTool,
    markitdown_convert_buffer: markItDownConvertBufferTool,
  },
});
