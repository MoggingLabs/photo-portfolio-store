// Resolve the absolute path of the repo-level openapi.yaml regardless of
// the current working directory. The api app lives at apps/api/src/lib,
// so the spec sits four directories up.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const openApiPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../openapi.yaml',
);
