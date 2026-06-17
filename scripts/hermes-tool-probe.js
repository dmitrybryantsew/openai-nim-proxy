const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const HERMES_EXE = process.env.HERMES_EXE;
const MOCK_PORT = Number(process.env.HERMES_PROBE_MOCK_PORT || 4160);
const PROXY_PORT = Number(process.env.HERMES_PROBE_PROXY_PORT || 3160);
const PROXY_KEY = process.env.HERMES_PROBE_PROXY_KEY || 'hermes-tool-probe-key';
const MODEL = 'nim:mock-tool-model';
const HERMES_HOME = process.env.HERMES_PROBE_HOME || path.join(process.cwd(), 'data', 'hermes-probe-home');

let requestCount = 0;
let sawTools = false;
let sawToolResult = false;
const upstreamRequests = [];

async function main() {
  if (!HERMES_EXE) {
    throw new Error('Set HERMES_EXE to the Hermes executable path before running this probe.');
  }

  prepareHermesHome();
  const mock = await startMockProvider();
  const proxy = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PROXY_PORT),
      PROXY_API_KEY: PROXY_KEY,
      NIM_API_BASE: `http://127.0.0.1:${MOCK_PORT}/v1`,
      NIM_API_KEY: 'mock-provider-key',
      MODEL_CACHE_FILE: '',
      CHAT_DB_FILE: ':memory:',
      OLLAMA_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let proxyOutput = '';
  proxy.stdout.on('data', (chunk) => {
    proxyOutput += chunk.toString();
  });
  proxy.stderr.on('data', (chunk) => {
    proxyOutput += chunk.toString();
  });

  try {
    await waitForProxy();
    const hermes = await runHermes();
    assert(hermes.code === 0, `Hermes exited with ${hermes.code}\n${hermes.output}`);
    assert(sawTools, `Hermes request did not include OpenAI tools\n${diagnostics(hermes.output)}`);
    assert(sawToolResult, `Hermes did not send a tool-result message after the tool call\n${diagnostics(hermes.output)}`);
    assert(/TOOL_RESULT_RECEIVED/.test(hermes.output), `Hermes final answer did not arrive\n${hermes.output}`);
    console.log('hermes tool-call probe ok');
  } finally {
    proxy.kill();
    mock.close();
  }

  proxy.on('exit', (code) => {
    if (code && code !== 0 && code !== null) {
      console.error(proxyOutput);
    }
  });
}

function diagnostics(hermesOutput) {
  return [
    `requestCount=${requestCount}`,
    `sawTools=${sawTools}`,
    `sawToolResult=${sawToolResult}`,
    `upstreamRequests=${JSON.stringify(upstreamRequests, null, 2)}`,
    '--- hermes output ---',
    hermesOutput,
  ].join('\n');
}

function prepareHermesHome() {
  fs.mkdirSync(HERMES_HOME, { recursive: true });
  fs.writeFileSync(path.join(HERMES_HOME, 'config.yaml'), `model:
  provider: custom:proxy-probe
  default: ${MODEL}
display:
  streaming: false
custom_providers:
- name: proxy-probe
  base_url: http://127.0.0.1:${PROXY_PORT}/v1
  api_mode: chat_completions
  model: ${MODEL}
  api_key: ${PROXY_KEY}
platform_toolsets:
  cli:
    - file
onboarding:
  seen:
    tool_progress_prompt: true
`);
  fs.writeFileSync(path.join(HERMES_HOME, '.env'), '');
}

function startMockProvider() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      return sendJson(res, {
        object: 'list',
        data: [{ id: 'mock-tool-model', object: 'model', owned_by: 'mock' }],
      });
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      requestCount += 1;
      const body = await readJson(req);
      upstreamRequests.push({
        stream: Boolean(body.stream),
        message_roles: Array.isArray(body.messages) ? body.messages.map((message) => message.role) : [],
        tool_count: Array.isArray(body.tools) ? body.tools.length : 0,
        tool_names: Array.isArray(body.tools) ? body.tools.map((tool) => tool?.function?.name).filter(Boolean) : [],
      });
      sawTools = sawTools || (Array.isArray(body.tools) && body.tools.some((tool) => tool?.function?.name === 'read_file'));
      sawToolResult = sawToolResult || (Array.isArray(body.messages) && body.messages.some((message) => message.role === 'tool'));

      if (body.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        if (sawToolResult || requestCount > 1) {
          writeChunk(res, body.model, { role: 'assistant' }, null);
          writeChunk(res, body.model, { content: 'TOOL_RESULT_RECEIVED' }, null);
          writeChunk(res, body.model, {}, 'stop');
          res.write('data: [DONE]\n\n');
          return res.end();
        }

        writeChunk(res, body.model, { role: 'assistant' }, null);
        writeChunk(res, body.model, {
          tool_calls: [{
            index: 0,
            id: 'call_readme',
            type: 'function',
            function: { name: 'read_file', arguments: '' },
          }],
        }, null);
        writeChunk(res, body.model, {
          tool_calls: [{
            index: 0,
            function: { arguments: '{"path":"README.md","offset":1,"limit":20}' },
          }],
        }, null);
        writeChunk(res, body.model, {}, 'tool_calls');
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      if (sawToolResult || requestCount > 1) {
        return sendJson(res, {
          id: 'chatcmpl-hermes-final',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'TOOL_RESULT_RECEIVED' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
        });
      }

      return sendJson(res, {
        id: 'chatcmpl-hermes-tool',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_readme',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: '{"path":"README.md","offset":1,"limit":20}',
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
      });
    }

    sendJson(res, { error: { message: `unexpected ${req.method} ${req.url}` } }, 404);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server));
  });
}

function writeChunk(res, model, delta, finishReason) {
  res.write(`data: ${JSON.stringify({
    id: 'chatcmpl-hermes-stream',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason,
    }],
  })}\n\n`);
}

function runHermes() {
  return new Promise((resolve) => {
    const child = spawn(HERMES_EXE, [
      '-z',
      'Use the read_file tool to inspect README.md, then answer with the model response.',
      '--provider',
      'custom:proxy-probe',
      '--model',
      MODEL,
      '--toolsets',
      'file',
      '--ignore-rules',
      '--yolo',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HERMES_HOME,
        HERMES_ACCEPT_HOOKS: '1',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('exit', (code) => resolve({ code, output }));
    child.on('error', (error) => resolve({ code: -1, output: error.message }));
  });
}

async function waitForProxy() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling.
    }
    await sleep(250);
  }

  throw new Error('proxy did not start in time');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(`${JSON.stringify(payload)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
