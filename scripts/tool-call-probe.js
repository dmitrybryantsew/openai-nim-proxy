const http = require('http');
const { spawn } = require('child_process');

const MOCK_PORT = Number(process.env.TOOL_PROBE_MOCK_PORT || 4150);
const PROXY_PORT = Number(process.env.TOOL_PROBE_PROXY_PORT || 3150);
const PROXY_KEY = process.env.TOOL_PROBE_PROXY_KEY || 'tool-probe-key';
const MODEL = 'nim:mock-tool-model';

let lastUpstreamBody = null;

async function main() {
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
    await probeNonStreamingToolCall();
    await probeStreamingToolCall();
    console.log('tool-call probe ok');
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

function startMockProvider() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      return sendJson(res, {
        object: 'list',
        data: [{ id: 'mock-tool-model', object: 'model', owned_by: 'mock' }],
      });
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const body = await readJson(req);
      lastUpstreamBody = body;

      if (body.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        writeChunk(res, body.model, { role: 'assistant' }, null);
        writeChunk(res, body.model, {
          tool_calls: [{
            index: 0,
            id: 'call_stream',
            type: 'function',
            function: { name: 'read_file', arguments: '' },
          }],
        }, null);
        writeChunk(res, body.model, {
          tool_calls: [{
            index: 0,
            function: { arguments: '{"path":"README.md"}' },
          }],
        }, null);
        writeChunk(res, body.model, {}, 'tool_calls');
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      return sendJson(res, {
        id: 'chatcmpl-probe',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: '{"path":"README.md"}',
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
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
    id: 'chatcmpl-probe-stream',
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

async function probeNonStreamingToolCall() {
  const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PROXY_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildRequest(false)),
  });

  if (!response.ok) {
    throw new Error(`non-streaming request failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  assert(data.model === MODEL, `expected public model ${MODEL}, got ${data.model}`);
  assert(toolCall?.function?.name === 'read_file', 'missing non-streaming tool call');
  assert(lastUpstreamBody.model === 'mock-tool-model', 'provider prefix was not stripped upstream');
  assert(lastUpstreamBody.parallel_tool_calls === true, 'parallel_tool_calls was not forwarded');
  assert(lastUpstreamBody.tool_choice?.function?.name === 'read_file', 'tool_choice was not forwarded');
  assert(Array.isArray(lastUpstreamBody.tools) && lastUpstreamBody.tools.length === 1, 'tools were not forwarded');
}

async function probeStreamingToolCall() {
  const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PROXY_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildRequest(true)),
  });

  if (!response.ok) {
    throw new Error(`streaming request failed: ${response.status} ${await response.text()}`);
  }
  const text = await response.text();
  assert(text.includes('"model":"nim:mock-tool-model"'), 'stream model was not rewritten to public id');
  assert(text.includes('"tool_calls"'), 'streaming tool_calls were not preserved');
  assert(text.includes('"finish_reason":"tool_calls"'), 'streaming finish_reason was not preserved');
}

function buildRequest(stream) {
  return {
    model: MODEL,
    stream,
    messages: [{ role: 'user', content: 'Read README.md' }],
    tools: [{
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
        },
      },
    }],
    tool_choice: { type: 'function', function: { name: 'read_file' } },
    parallel_tool_calls: true,
  };
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
