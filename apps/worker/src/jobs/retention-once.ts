#!/usr/bin/env tsx
// Emergency manual purge CLI — runs a single retention pass and exits.
// Useful for on-call response when the cron is down or a regulator demands
// proof of immediate action. Not invoked by the scheduler.
//
// Usage: pnpm --filter @app/worker tsx src/jobs/retention-once.ts

import { db } from '../lib/db.js';
import { qdrant } from '../lib/qdrant.js';
import { runRetentionPass } from './retention.js';

const result = await runRetentionPass(db, qdrant);
// Intentional console.log: this is a CLI tool, stdout is the contract.
// eslint-disable-next-line no-console
console.log(JSON.stringify(result, null, 2));
process.exit(0);
