// Offline smoke test: real CLI validation, tool schemas, and native image blocks.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const file = fileURLToPath(new URL('./tests/plugin.test.mjs', import.meta.url))
const run = spawnSync(process.execPath, ['--test', file], { stdio: 'inherit', windowsHide: true })
process.exitCode = run.status ?? 1
