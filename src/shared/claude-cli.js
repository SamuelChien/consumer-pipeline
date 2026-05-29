import { spawn } from 'child_process';

const CLAUDE_BIN = '/usr/local/bin/claude';

let pending = Promise.resolve();

function runClaude(prompt, { maxTokens = 8000, timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, ['-p', '--max-turns', '1', '--allowedTools', 'none'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens) },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude -p exited ${code}: ${(stderr || stdout).slice(0, 500)}`));
      resolve(stdout.trim());
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`claude -p spawn failed: ${err.message}`));
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

export function claudeGenerate(prompt, opts) {
  const next = pending.then(() => runClaude(prompt, opts));
  pending = next.catch(() => {});
  return next;
}

/**
 * Run Claude Code as a MULTI-TURN agent with tools (the research-agent path).
 * Unlike runClaude (one shot, no tools) this lets Opus actually read code,
 * grep skills, run gcloud, and web-search before answering.
 *
 * Returns { result, meta, raw } where result is the final assistant message.
 * With { dryRun:true } it returns { dryRun:true, command, cwd } without spawning.
 */
export function claudeAgent(prompt, {
  model = process.env.RESEARCH_MODEL || 'claude-opus-4-8',
  maxTurns = Number(process.env.RESEARCH_MAX_TURNS || 40),
  allowedTools = (process.env.RESEARCH_ALLOWED_TOOLS ||
    'Read Grep Glob WebSearch Bash(gcloud:*) Bash(cat:*) Bash(ls:*) Bash(rg:*) Bash(find:*)')
    .split(/\s*,\s*|\s+/).filter(Boolean),
  permissionMode = process.env.RESEARCH_PERMISSION_MODE || 'bypassPermissions',
  cwd,
  addDirs = [],
  timeoutMs = Number(process.env.RESEARCH_TIMEOUT_MS || 1_200_000),
  maxTokens = 16000,
  dryRun = false,
} = {}) {
  const args = [
    '-p',
    '--model', model,
    '--max-turns', String(maxTurns),
    '--output-format', 'json',
    '--permission-mode', permissionMode,
    '--allowedTools', allowedTools.join(' '),
  ];
  for (const dir of addDirs) args.push('--add-dir', dir);

  if (dryRun) {
    const quoted = args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
    return Promise.resolve({
      dryRun: true,
      command: `${CLAUDE_BIN} ${quoted}`,
      cwd: cwd || process.cwd(),
      promptPreview: prompt.slice(0, 1200),
    });
  }

  const run = () => new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, args, {
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens) },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`claude agent timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`claude agent exited ${code}: ${(stderr || stdout).slice(0, 800)}`));
      }
      // --output-format json wraps the run: { result, num_turns, total_cost_usd, usage, ... }
      let env;
      try { env = JSON.parse(stdout); } catch {
        return resolve({ result: stdout.trim(), meta: {}, raw: stdout });
      }
      resolve({
        result: typeof env.result === 'string' ? env.result : JSON.stringify(env.result ?? ''),
        meta: {
          num_turns: env.num_turns,
          total_cost_usd: env.total_cost_usd,
          usage: env.usage,
          session_id: env.session_id,
          is_error: env.is_error,
        },
        raw: stdout,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`claude agent spawn failed: ${err.message}`));
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });

  // Serialize through the same chain so long agent runs don't stampede.
  const next = pending.then(run);
  pending = next.catch(() => {});
  return next;
}

/**
 * Run Claude as a ONE-SHOT prose responder with NO tools — the eval-gate path.
 *
 * The gate measures whether a skill's guidance improves the model's WRITTEN answer,
 * so the model must produce prose, not go agentic. We therefore:
 *   - disable every built-in tool with `--tools ""` and every MCP tool with
 *     `--strict-mcp-config` (loads no MCP servers). Without this the model spends
 *     its single turn on a tool call, hits error_max_turns, and returns an EMPTY
 *     response — which is exactly the "eval scored 0 / assertions_total 0" bug.
 *   - strip CLAUDECODE: when this runs nested inside a Claude Code session the var
 *     leaks in and alters headless behavior (the skill-bench judge strips it too).
 *   - cap at one turn and parse the json envelope for the final text + usage.
 *
 * Resolves (never rejects) with { response, usage, isError, error, raw } so callers
 * can record an infra error instead of crashing the whole gate.
 */
export function claudeProse(prompt, {
  model = process.env.EVAL_MODEL || 'claude-sonnet-4-6',
  timeoutMs = 300_000,
  maxTokens = 8000,
  maxAttempts = 4,
  retryDelayMs = 4000,
  dryRun = false,
} = {}) {
  const args = [
    '-p', prompt,
    '--model', model,
    '--max-turns', '1',
    '--output-format', 'json',
    '--tools', '',            // disable all built-in tools
    '--strict-mcp-config',    // load no MCP servers -> no MCP tools either
  ];

  if (dryRun) {
    return Promise.resolve({ dryRun: true, model, promptPreview: prompt.slice(0, 800) });
  }

  const env = { ...process.env, FORCE_COLOR: '0', CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens) };
  delete env.CLAUDECODE;

  const attempt = () => new Promise((resolve) => {
    const proc = spawn(CLAUDE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ response: '', usage: {}, isError: true, error: `claude prose timed out after ${timeoutMs}ms`, raw: stdout });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      let envelope;
      try { envelope = JSON.parse(stdout); } catch {
        return resolve({
          response: stdout.trim(), usage: {}, isError: code !== 0,
          error: code !== 0 ? `claude exited ${code}: ${(stderr || stdout).slice(0, 300)}` : null,
          raw: stdout,
        });
      }
      const response = typeof envelope.result === 'string' ? envelope.result : '';
      resolve({
        response,
        usage: envelope.usage || {},
        isError: !!envelope.is_error,
        error: envelope.is_error ? (envelope.subtype || 'is_error') : null,
        raw: stdout,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ response: '', usage: {}, isError: true, error: `claude prose spawn failed: ${err.message}`, raw: '' });
    });
  });

  // Transient API hiccups (rate limits, 5xx) surface as isError or an empty
  // response; retry with linear backoff since these calls are idempotent reads.
  // (The eval gate saw ~2/4 pairwise rounds fail this way without a retry.)
  // Serialize through the shared chain so eval calls don't stampede long agent runs.
  const runWithRetry = async () => {
    let result;
    for (let i = 0; i < maxAttempts; i++) {
      result = await attempt();
      if (!result.isError && result.response.trim()) return result;
      if (i < maxAttempts - 1) await new Promise((r) => setTimeout(r, retryDelayMs * 2 ** i)); // 4s, 8s, 16s — rate-limit friendly
    }
    return result;
  };
  const next = pending.then(runWithRetry);
  pending = next.catch(() => {});
  return next;
}

export async function claudeJSON(prompt, opts) {
  const text = await claudeGenerate(prompt + '\n\nReturn valid JSON only. No markdown fences, no commentary before or after the JSON.', opts);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in claude response');
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    const cleaned = match[0].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    try { return JSON.parse(cleaned); } catch {}
    const lastBrace = match[0].lastIndexOf('}');
    if (lastBrace > 0) {
      try { return JSON.parse(match[0].slice(0, lastBrace + 1)); } catch {}
    }
    throw e;
  }
}
