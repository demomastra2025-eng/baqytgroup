import { createTool } from '@mastra/core/tools';
import { MCPServer } from '@mastra/mcp';
import { z } from 'zod';

import { MACROCRM_OPERATIONS, type MacroCrmOperationSpec } from './macrocrm-operations';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';

const DEFAULT_BASE_URL = process.env.MACROCRM_BASE_URL ?? 'https://api.yourserver.com/v2';
const DEFAULT_APP_ID = process.env.MACROCRM_APP_ID ?? '9';
const DEFAULT_APP_TOKEN =
  process.env.MACROCRM_APP_TOKEN ??
  'macro-4D39Ynbx77cAwXnVXecrO2E_CLcBR9kD7pNxxLHU6qtyfodBZYWaXSM6q1U4CAGmk1-IF2Wu2-BDFv7ojOct_GB6O_jSrFLh2lgqVZ3zwfERZY344ITVltUpsGFhEZMaR3wxNzYxNjU5MTIzfGNjNDg1';

const MacroCrmCallParametersSchema = z.object({
  pathParams: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .describe('Dictionary of path parameter replacements.')
    .optional(),
  query: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]).nullable())
    .describe('Query string parameters.')
    .optional(),
  body: z.unknown().describe('Request body payload for operations that require it.').optional(),
  headers: z
    .record(z.string(), z.string())
    .describe('Additional headers to include with the request.')
    .optional(),
});

const MacroCrmFlexibleCallInputSchema = MacroCrmCallParametersSchema.extend({
  operationId: z
    .string()
    .describe(
      'Identifier of the MacroCRM operation (use tool id or slug from describe_macrocrm_operation).',
    )
    .optional(),
  method: z
    .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'])
    .describe('HTTP method to match when operationId is not provided.')
    .optional(),
  path: z
    .string()
    .describe('API path to match when operationId is not provided (e.g., /company/getUsers).')
    .optional(),
}).refine(
  ({ operationId, method, path }) => Boolean(operationId || (method && path)),
  'Provide operationId, or both method and path.',
);

type MacroCrmCallParameters = z.infer<typeof MacroCrmCallParametersSchema>;
type MacroCrmFlexibleCallInput = z.infer<typeof MacroCrmFlexibleCallInputSchema>;

type MacroCrmOperationMeta = MacroCrmOperationSpec & {
  slug: string;
  toolId: string;
};

const sanitizeOperationIdentifier = (operation: MacroCrmOperationSpec) => {
  const raw = `${operation.method}_${operation.path}`.replace(/[{}]/g, '');
  const sanitized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized.length > 0 ? sanitized : `${operation.method.toLowerCase()}_operation`;
};

const slugOccurrences = new Map<string, number>();

const OPERATIONS_WITH_META: MacroCrmOperationMeta[] = MACROCRM_OPERATIONS.map((operation) => {
  const baseSlug = sanitizeOperationIdentifier(operation);
  const seen = slugOccurrences.get(baseSlug) ?? 0;
  slugOccurrences.set(baseSlug, seen + 1);
  const slug = seen === 0 ? baseSlug : `${baseSlug}_${seen + 1}`;

  return {
    ...operation,
    slug,
    toolId: `macrocrm_${slug}`,
  };
});

const OPERATIONS_BY_METHOD_PATH = new Map<string, MacroCrmOperationMeta>();
for (const operation of OPERATIONS_WITH_META) {
  OPERATIONS_BY_METHOD_PATH.set(`${operation.method} ${operation.path}`, operation);
}

const findOperation = ({
  operationId,
  method,
  path,
}: {
  operationId?: string;
  method?: HttpMethod;
  path?: string;
}) => {
  if (operationId) {
    const normalized = operationId.toLowerCase();
    const slugCandidate = normalized.replace(/^macrocrm_/, '');
    const toolIdCandidate = `macrocrm_${slugCandidate}`;
    return OPERATIONS_WITH_META.find(
      (operation) =>
        operation.toolId.toLowerCase() === normalized ||
        operation.toolId.toLowerCase() === toolIdCandidate ||
        operation.slug === slugCandidate,
    );
  }

  if (method && path) {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return (
      OPERATIONS_BY_METHOD_PATH.get(`${method.toUpperCase()} ${normalizedPath}`) ??
      OPERATIONS_BY_METHOD_PATH.get(`${method.toUpperCase()} ${path}`)
    );
  }

  return undefined;
};

const maskHeaderValue = (value?: string | null) => {
  if (!value) return value ?? '';
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`;
};

const executeMacroCrmCall = async (
  operation: MacroCrmOperationMeta,
  params: MacroCrmCallParameters,
  options: { abortSignal?: AbortSignal } = {},
) => {
  const baseUrl = DEFAULT_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      'MacroCRM base URL is not configured. Set MACROCRM_BASE_URL in the environment variables.',
    );
  }

  const rawPath = operation.path.startsWith('/') ? operation.path : `/${operation.path}`;
  const resolvedPath = rawPath.replace(/{([^}]+)}/g, (placeholder, key) => {
    const value = params.pathParams?.[key];
    if (value === undefined) {
      throw new Error(`Missing path parameter "${key}" for MacroCRM API call.`);
    }
    return encodeURIComponent(String(value));
  });

  const baseWithSlash = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const relativePath = resolvedPath.startsWith('/') ? resolvedPath.slice(1) : resolvedPath;
  const url = new URL(relativePath, baseWithSlash);

  if (params.query) {
    for (const [queryKey, queryValue] of Object.entries(params.query)) {
      if (queryValue === null || queryValue === undefined) continue;
      url.searchParams.append(queryKey, String(queryValue));
    }
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    AppId: DEFAULT_APP_ID,
    ...params.headers,
  };

  if (DEFAULT_APP_TOKEN) {
    headers.Authorization = `Bearer ${DEFAULT_APP_TOKEN}`;
  }

  let body: BodyInit | undefined;
  if (params.body !== undefined && params.body !== null) {
    if (!headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    if (headers['Content-Type'].includes('application/json') && typeof params.body !== 'string') {
      body = JSON.stringify(params.body);
    } else if (typeof params.body === 'string') {
      body = params.body;
    } else {
      body = JSON.stringify(params.body);
    }
  }

  const response = await fetch(url.toString(), {
    method: operation.method,
    headers,
    body,
    signal: options.abortSignal,
  });

  const responseHeaders = Object.fromEntries(response.headers.entries());
  const responseText = await response.text();
  let parsedBody: unknown = responseText;

  try {
    parsedBody = responseText ? JSON.parse(responseText) : null;
  } catch {
    // keep raw text when JSON parsing fails
  }

  const { Authorization: authHeader, ...requestHeaders } = headers;

  return {
    request: {
      operation: operation.slug,
      method: operation.method,
      url: url.toString(),
      headers: {
        ...requestHeaders,
        Authorization: authHeader ? maskHeaderValue(authHeader) : undefined,
      },
      body: params.body ?? null,
    },
    response: {
      status: response.status,
      ok: response.ok,
      headers: responseHeaders,
      body: parsedBody,
      rawBody: responseText,
    },
  };
};

export const describeMacroCrmOperation = createTool({
  id: 'describe_macrocrm_operation',
  description:
    'Возвращает информацию об операциях MacroCRM, доступных в MCP. Используйте, чтобы найти нужный endpoint и узнать его toolId.',
  inputSchema: z
    .object({
      operationId: z
        .string()
        .describe('Искать по toolId или slug (например, macrocrm_get_company_getusers).')
        .optional(),
      method: z
        .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'])
        .describe('Фильтр по HTTP-методу.')
        .optional(),
      path: z
        .string()
        .describe('Подстрока или точный путь (например, /company/getUsers).')
        .optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(5)
        .describe('Максимальное количество результатов.')
        .optional(),
    })
    .refine(
      (value) => Boolean(value.operationId || value.method || value.path),
      'Передайте хотя бы один фильтр: operationId, method или path.',
    ),
  execute: async ({ context }) => {
    const { operationId, method, path, limit = 5 } = context;

    const normalizedOperationId = operationId?.toLowerCase();
    const normalizedPath = path?.toLowerCase();

    const matches = OPERATIONS_WITH_META.filter((operation) => {
      const matchesId = normalizedOperationId
        ? operation.toolId.toLowerCase().includes(normalizedOperationId) ||
          operation.slug.includes(normalizedOperationId.replace(/^macrocrm_/, ''))
        : true;
      const matchesMethod = method ? operation.method === method : true;
      const matchesPath = normalizedPath
        ? operation.path.toLowerCase().includes(normalizedPath)
        : true;

      return matchesId && matchesMethod && matchesPath;
    });

    if (matches.length === 0) {
      return {
        message: 'Подходящие операции MacroCRM не найдены для указанных фильтров.',
        filters: context,
      };
    }

    return matches.slice(0, limit).map((operation) => ({
      toolId: operation.toolId,
      slug: operation.slug,
      method: operation.method,
      path: operation.path,
      summary: operation.summary,
      description: operation.description,
      tags: operation.tags,
      parameters: operation.parameters,
      requestBody: operation.requestBody,
      responses: Object.keys(operation.responses ?? {}),
    }));
  },
});

export const callMacroCrmOperation = createTool({
  id: 'call_macrocrm_operation',
  description:
    'Выполняет REST-вызов MacroCRM. Укажите operationId (toolId или slug из describe_macrocrm_operation) или пару method+path.',
  inputSchema: MacroCrmFlexibleCallInputSchema,
  execute: async ({ context }, options) => {
    const operation = findOperation({
      operationId: context.operationId,
      method: context.method,
      path: context.path,
    });

    if (!operation) {
      throw new Error(
        'MacroCRM операция не найдена. Используйте describe_macrocrm_operation, чтобы получить корректный toolId или путь.',
      );
    }

    const { pathParams, query, body, headers } = context;
    return executeMacroCrmCall(operation, { pathParams, query, body, headers }, options ?? {});
  },
});

const macroCrmOperationToolsEntries = OPERATIONS_WITH_META.map((operation) => {
  const descriptionParts = [
    `${operation.method} ${operation.path}`,
    operation.summary,
    operation.description,
  ].filter(Boolean);

  return [
    operation.toolId,
    createTool({
      id: operation.toolId,
      description:
        descriptionParts.join(' — ') ||
        `Вызов MacroCRM ${operation.method} ${operation.path}.`,
      inputSchema: MacroCrmCallParametersSchema,
      execute: async ({ context }, options) =>
        executeMacroCrmCall(operation, context, options ?? {}),
    }),
  ] as const;
});

export const macroCrmOperationTools = Object.fromEntries(macroCrmOperationToolsEntries);

export const macroCrmMcpServer = new MCPServer({
  id: 'macrocrm-mcp-server',
  name: 'MacroCRM API',
  version: '1.0.0',
  description:
    'Expose MacroCRM REST API methods as individual MCP tools. Используйте describe_macrocrm_operation или конкретные тулзы для вызовов.',
  tools: {
    describe_macrocrm_operation: describeMacroCrmOperation,
    call_macrocrm_operation: callMacroCrmOperation,
    ...macroCrmOperationTools,
  },
});
