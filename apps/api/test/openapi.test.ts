// Structural validation of the repo-level openapi.yaml. Catches drift in
// spec hygiene (missing operationIds, dangling $refs, missing success
// responses) before it pollutes codegen output.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { openApiPath } from '../src/lib/openapi-path.js';

interface OperationObject {
  operationId?: string;
  summary?: string;
  tags?: string[];
  responses?: Record<string, unknown>;
}

interface PathItem {
  [method: string]: OperationObject | unknown;
}

interface OpenApiDoc {
  openapi: string;
  info: { version: string };
  paths: Record<string, PathItem>;
  components?: { schemas?: Record<string, unknown> };
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);

const SUCCESS_CODES = new Set(['200', '201', '202', '204']);

const collectRefs = (node: unknown, out: string[] = []): string[] => {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
    return out;
  }
  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (key === '$ref' && typeof value === 'string') out.push(value);
    else collectRefs(value, out);
  }
  return out;
};

const loadDoc = (): OpenApiDoc => {
  const raw = readFileSync(openApiPath, 'utf8');
  return parseYaml(raw) as OpenApiDoc;
};

describe('openapi.yaml', () => {
  const doc = loadDoc();

  it('declares OpenAPI 3.1', () => {
    expect(doc.openapi).toMatch(/^3\.1/);
  });

  it('exposes the expected info.version', () => {
    expect(doc.info.version).toBe('0.1.0');
  });

  it('every operation has an operationId, summary and at least one tag', () => {
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      for (const [method, op] of Object.entries(item ?? {})) {
        if (!HTTP_METHODS.has(method)) continue;
        const operation = op as OperationObject;
        expect(
          operation.operationId,
          `${method.toUpperCase()} ${path} missing operationId`,
        ).toBeTypeOf('string');
        expect(operation.summary, `${method.toUpperCase()} ${path} missing summary`).toBeTypeOf(
          'string',
        );
        expect(
          operation.tags?.length ?? 0,
          `${method.toUpperCase()} ${path} missing tag`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('every operation declares at least one success response', () => {
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      for (const [method, op] of Object.entries(item ?? {})) {
        if (!HTTP_METHODS.has(method)) continue;
        const operation = op as OperationObject;
        const codes = Object.keys(operation.responses ?? {});
        const hasSuccess = codes.some((c) => SUCCESS_CODES.has(c));
        expect(
          hasSuccess,
          `${method.toUpperCase()} ${path} has no 2xx response (got [${codes.join(', ')}])`,
        ).toBe(true);
      }
    }
  });

  it('every $ref resolves to a defined component', () => {
    const refs = collectRefs(doc);
    for (const ref of refs) {
      expect(ref.startsWith('#/'), `External or relative ref not allowed: ${ref}`).toBe(true);
      const segments = ref.slice(2).split('/');
      let cursor: unknown = doc;
      for (const seg of segments) {
        expect(
          cursor && typeof cursor === 'object' && seg in (cursor as Record<string, unknown>),
          `Unresolvable ref ${ref} (missing segment "${seg}")`,
        ).toBe(true);
        cursor = (cursor as Record<string, unknown>)[seg];
      }
    }
  });
});
