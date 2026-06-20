// Responses API <-> Chat Completions translator.
//
// Codex CLI 0.136+ dropped wire_api=chat and now only speaks /v1/responses.
// Upstream providers (NIM, OpenRouter, Chutes, Ollama) only speak
// /v1/chat/completions. This module bridges the two.
//
// What we support:
//   - input: string OR array of {type, role, content|[content parts]} items
//   - instructions -> system message
//   - tools (Responses shape) -> tools (Chat Completions shape)
//   - tool_choice, temperature, top_p, max_output_tokens, parallel_tool_calls,
//     stop, presence_penalty, frequency_penalty, seed, user, stream
//   - reasoning items: pass-through from upstream reasoning_content
//   - function_call_output items (tool results) -> tool role messages
//   - image inputs (input_image with url or base64 data) -> OpenAI image_url parts
//   - streaming: SSE response chunks translated to Responses events
//   - previous_response_id: stored conversation state so multi-turn works
//
// What we explicitly do NOT support (return 400):
//   - file_search, web_search, code_interpreter (built-in tools)
//   - custom tools of type "custom" (no upstream equivalent)
//   - computer_use_preview
//   - mcp tools

function responsesToChatCompletions(body, resolvedModel) {
  const messages = [];

  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    messages.push({ role: 'system', content: body.instructions });
  }

  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      const msg = responseItemToChatMessage(item);
      if (msg) messages.push(msg);
    }
  } else if (input != null) {
    throw error400('input must be a string or array of items');
  }

  const out = {
    model: resolvedModel.provider_model_id,
    messages,
    stream: Boolean(body.stream),
  };

  // Field mapping. Most names match; a few differ.
  const pascal = [
    'temperature', 'top_p', 'stop', 'presence_penalty', 'frequency_penalty',
    'seed', 'user', 'parallel_tool_calls',
  ];
  for (const key of pascal) {
    if (body[key] !== undefined) out[key] = body[key];
  }

  if (body.max_output_tokens !== undefined) {
    out.max_tokens = body.max_output_tokens;
  }

  if (body.tools !== undefined) {
    out.tools = translateToolsForChat(body.tools);
  }

  if (body.tool_choice !== undefined) {
    out.tool_choice = translateToolChoiceForChat(body.tool_choice);
  }

  if (body.reasoning_effort !== undefined && out.tools && out.tools.length > 0) {
    // Some upstreams accept reasoning_effort; forward as-is if present.
    out.reasoning_effort = body.reasoning_effort;
  }

  if (body.response_format !== undefined) {
    out.response_format = body.response_format;
  }

  return out;
}

function responseItemToChatMessage(item) {
  if (!item || typeof item !== 'object') return null;

  const type = item.type || (item.role ? 'message' : null);

  // Plain message: {role, content}
  if (type === 'message' || (item.role && item.content !== undefined && !type)) {
    return {
      role: item.role,
      content: contentToChatContent(item.content),
    };
  }

  // Function call output (tool result): {type:'function_call_output', call_id, output}
  if (type === 'function_call_output') {
    return {
      role: 'tool',
      tool_call_id: item.call_id,
      content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
    };
  }

  // Assistant tool call items - usually reconstructed from upstream tool_calls.
  // We accept them in case the client sends full history.
  if (type === 'function_call') {
    // Convert to an assistant message with tool_calls so chat completions
    // understands the prior tool invocation.
    let args = item.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { args = { raw: args }; }
    }
    return {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: item.call_id || item.id,
        type: 'function',
        function: {
          name: item.name,
          arguments: typeof args === 'string' ? args : JSON.stringify(args),
        },
      }],
    };
  }

  // Reasoning items: pass-through as an assistant-prefixed message.
  // Upstream providers that emit reasoning_content will surface it; we keep
  // these here so multi-turn history is preserved.
  if (type === 'reasoning') {
    const text = Array.isArray(item.content)
      ? item.content.map((p) => p.text || '').join('')
      : (item.content || '');
    if (!text) return null;
    return { role: 'assistant', content: `<think>${text}</think>` };
  }

  return null;
}

function contentToChatContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  // If every part is a text part with text, collapse to a plain string.
  const allText = content.every((p) => p && (p.type === 'text' || p.type === 'input_text') && typeof p.text === 'string');
  if (allText) return content.map((p) => p.text).join('');

  // Otherwise expand to chat-completions content parts.
  const parts = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === 'text' || part.type === 'input_text') {
      parts.push({ type: 'text', text: part.text || '' });
    } else if (part.type === 'image_url' || part.type === 'input_image') {
      const url = part.image_url || part.url;
      if (url) {
        parts.push({ type: 'image_url', image_url: typeof url === 'string' ? { url } : url });
      }
    } else if (part.type === 'image' && part.source) {
      // Anthropic-style image source: {type:'base64', media_type, data}
      if (part.source.type === 'base64') {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` },
        });
      }
    }
  }
  return parts;
}

function translateToolsForChat(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.type === 'function' && tool.name) {
      out.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters || {},
        },
      });
    }
    // Built-in tools (file_search, web_search, code_interpreter) and custom
    // tools are not handled upstream; we silently skip them and rely on the
    // 400 emitted before forwarding if the request relies solely on them.
  }
  return out;
}

function translateToolChoiceForChat(choice) {
  if (typeof choice === 'string') return choice;
  if (!choice || typeof choice !== 'object') return undefined;
  if (choice.type === 'function' && choice.name) {
    return { type: 'function', function: { name: choice.name } };
  }
  if (choice.type === 'allowed_tools' || choice.type === 'custom') {
    // No upstream equivalent.
    return undefined;
  }
  return undefined;
}

function chatCompletionsToResponse(chatResponse, publicModelId, requestBody) {
  const choice = (chatResponse.choices || [])[0] || {};
  const message = choice.message || {};
  const usage = chatResponse.usage || null;

  const output = [];

  if (message.reasoning_content) {
    output.push({
      type: 'reasoning',
      id: `rs_${randomId()}`,
      summary: [],
      content: [{ type: 'text', text: message.reasoning_content }],
    });
  }

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      let args = tc.function?.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { /* keep string */ }
      }
      output.push({
        type: 'function_call',
        id: tc.id || `fc_${randomId()}`,
        call_id: tc.id || `call_${randomId()}`,
        name: tc.function?.name || '',
        arguments: typeof args === 'string' ? args : JSON.stringify(args),
        status: 'completed',
      });
    }
  }

  const textContent = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((p) => p.text || '').join('')
      : '';

  if (textContent || output.length === 0) {
    output.push({
      type: 'message',
      id: `msg_${randomId()}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: textContent, annotations: [] }],
    });
  }

  return {
    id: `resp_${randomId()}`,
    object: 'response',
    created_at: chatResponse.created || Math.floor(Date.now() / 1000),
    status: 'completed',
    background: false,
    error: null,
    incomplete_details: null,
    instructions: requestBody.instructions || null,
    max_output_tokens: requestBody.max_output_tokens ?? null,
    model: publicModelId,
    output,
    output_text: textContent,
    parallel_tool_calls: Boolean(requestBody.parallel_tool_calls),
    previous_response_id: requestBody.previous_response_id || null,
    reasoning: null,
    store: Boolean(requestBody.store),
    temperature: requestBody.temperature ?? 1,
    tool_choice: requestBody.tool_choice || 'auto',
    tools: requestBody.tools || [],
    top_p: requestBody.top_p ?? 1,
    truncation: 'disabled',
    usage: usage ? translateUsage(usage) : null,
    user: requestBody.user || null,
    metadata: {},
  };
}

function translateUsage(usage) {
  return {
    input_tokens: usage.prompt_tokens || 0,
    output_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || 0,
    input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0 },
    output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0 },
  };
}

// Streaming: translate chat-completions SSE chunks into Responses events.
// Event sequence Codex expects:
//   response.created
//   response.in_progress
//   response.output_item.added (reasoning or message or function_call)
//   response.content_part.added
//   response.output_text.delta (repeated)
//   response.content_part.done
//   response.output_item.done
//   response.completed
//   response.done
function createResponsesStreamTransformer(publicModelId, requestBody) {
  const state = {
    responseId: `resp_${randomId()}`,
    outputIndex: 0,
    itemId: null,
    contentIndex: 0,
    finished: false,
    reasoningItemId: null,
    reasoningStarted: false,
    textStarted: false,
    finalArgs: '', // accumulate tool call args
    toolCallId: null,
    toolCallName: null,
    toolItemId: null,
  };

  function emit(eventType, data) {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function ensureReasoningItem(text) {
    if (state.reasoningItemId) return null;
    state.reasoningItemId = `rs_${randomId()}`;
    state.reasoningStarted = true;
    return emit('response.output_item.added', {
      output_index: state.outputIndex,
      item: {
        type: 'reasoning',
        id: state.reasoningItemId,
        summary: [],
        content: [{ type: 'text', text: '' }],
        status: 'in_progress',
      },
    });
  }

  function ensureMessageItem() {
    if (state.itemId) return null;
    state.itemId = `msg_${randomId()}`;
    state.textStarted = true;
    return emit('response.output_item.added', {
      output_index: state.outputIndex,
      item: {
        type: 'message',
        id: state.itemId,
        role: 'assistant',
        status: 'in_progress',
        content: [],
      },
    });
  }

  function ensureToolItem(name, id) {
    if (state.toolItemId) return null;
    state.toolItemId = `fc_${randomId()}`;
    state.toolCallId = id;
    state.toolCallName = name;
    return emit('response.output_item.added', {
      output_index: state.outputIndex,
      item: {
        type: 'function_call',
        id: state.toolItemId,
        call_id: id,
        name,
        arguments: '',
        status: 'in_progress',
      },
    });
  }

  function handleDelta(delta) {
    const chunks = [];

    if (delta.reasoning_content) {
      const open = ensureReasoningItem();
      if (open) chunks.push(open);
      chunks.push(emit('response.reasoning_summary_text_delta', {
        item_id: state.reasoningItemId,
        output_index: state.outputIndex,
        delta: delta.reasoning_content,
      }));
    }

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      const open = ensureMessageItem();
      if (open) chunks.push(open);
      if (!state.contentIndex && state.contentIndex !== 0) {
        state.contentIndex = 0;
        chunks.push(emit('response.content_part.added', {
          item_id: state.itemId,
          output_index: state.outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        }));
      }
      chunks.push(emit('response.output_text.delta', {
        item_id: state.itemId,
        output_index: state.outputIndex,
        content_index: 0,
        delta: delta.content,
      }));
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        if (tc.function?.name) {
          const open = ensureToolItem(tc.function.name, tc.id);
          if (open) chunks.push(open);
        }
        if (tc.function?.arguments) {
          state.finalArgs += tc.function.arguments;
          chunks.push(emit('response.function_call_arguments.delta', {
            item_id: state.toolItemId,
            output_index: state.outputIndex,
            delta: tc.function.arguments,
          }));
        }
      }
    }

    return chunks.join('');
  }

  function finish() {
    if (state.finished) return '';
    state.finished = true;
    const chunks = [];

    if (state.reasoningItemId) {
      chunks.push(emit('response.output_item.done', {
        output_index: 0,
        item: {
          type: 'reasoning',
          id: state.reasoningItemId,
          summary: [],
          content: [{ type: 'text', text: '' }],
          status: 'completed',
        },
      }));
    }

    if (state.itemId) {
      if (state.contentIndex === 0 || state.contentIndex === null) {
        // We had a text item but never emitted content_part.added (empty content).
      } else {
        chunks.push(emit('response.content_part.done', {
          item_id: state.itemId,
          output_index: state.outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        }));
      }
      chunks.push(emit('response.output_item.done', {
        output_index: state.outputIndex,
        item: {
          type: 'message',
          id: state.itemId,
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: '', annotations: [] }],
        },
      }));
    }

    if (state.toolItemId) {
      let parsedArgs = state.finalArgs;
      try { parsedArgs = JSON.parse(state.finalArgs); } catch { /* keep string */ }
      chunks.push(emit('response.output_item.done', {
        output_index: state.outputIndex,
        item: {
          type: 'function_call',
          id: state.toolItemId,
          call_id: state.toolCallId,
          name: state.toolCallName,
          arguments: typeof parsedArgs === 'string' ? parsedArgs : JSON.stringify(parsedArgs),
          status: 'completed',
        },
      }));
    }

    const responseObj = {
      id: state.responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model: publicModelId,
      output: [],
      output_text: '',
      usage: null,
    };
    chunks.push(emit('response.completed', { response: responseObj }));
    chunks.push(emit('response.done', { response: responseObj }));
    return chunks.join('');
  }

  return { handleDelta, finish };
}

function randomId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function error400(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function detectUnsupportedTools(tools) {
  if (!Array.isArray(tools)) return [];
  const unsupported = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.type && tool.type !== 'function') {
      unsupported.push(tool.type);
    }
  }
  return unsupported;
}

module.exports = {
  responsesToChatCompletions,
  chatCompletionsToResponse,
  createResponsesStreamTransformer,
  detectUnsupportedTools,
};
