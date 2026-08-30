#!/usr/bin/env node

import { runCli } from './src/cli.ts';

process.exitCode = await runCli(process.argv.slice(2));
