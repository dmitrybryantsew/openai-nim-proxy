// Responses API <-> Chat Completions translator.
//
// Codex CLI 0.136+ dropped wire_api=chat and now only speaks /v1/responses.
// Upstream providers (NIM, OpenRouter, Chutes, Ollama) only speak
// /v1/chat/completions. This module bridges the two.
//
// Public API:
//   responsesToChatCompletions(body, resolvedModel) -> chatBody
//   chatCompletionsToResponse(chatData, publicModelId, requestBody) -> responseObj
//   createResponsesStreamTransformer(publicModelId, requestBody) -> { handleDelta, finish }
//
// Streaming event sequence emitted (matches OpenAI Responses API):
//   response.created
//   response.in_progress
//   response.output_item.added (reasoning | message | function_call)
//   response.content_part.added (for messages)
//   response.output_text.delta (repeated)
//   response.function_call_arguments.delta (repeated, for tools)
//   response.content_part.done
//   response.output_item.done
//   response.completed (with full final output)
//   response.done

function randomId(prefix) {
  const s = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  return prefix ? `${prefix}_${s}` : s;
}

// ---- Request translation: Responses -> Chat Completions ----

function responsesToChatCompletions(body, _resolvedModel) {
  const { input, instructions, ...rest } = body;
  const messages = [];

  if (typeof instructions === 'string' && instructions.length > 0) {
    messages.push({ role: 'system', content: instructions });
  }

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const role = item.role;
      if (role === 'system' || role === 'user' || role === 'assistant') {
        messages.push({ role, content: extractText(item.content) });
        continue;
      }
      if (item.type === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id || item.id || '',
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
        });
        continue;
      }
      if (typeof item.content === 'string' || Array.isArray(item.content)) {
        messages.push({
          role: role || 'user',
          content: extractText(item.content),
        });
      }
    }
  }

  const chatBody = { ...rest, messages };
  if (chatBody.max_output_tokens != null && chatBody.max_tokens == null) {
    chatBody.max_tokens = chatBody.max_output_tokens;
    delete chatBody.max_output_tokens;
  }
  if (chatBody.parallel_tool_calls != null && chatBody.parallel_tool_calls === false) {
    delete chatBody.parallel_tool_calls;
  }
  if (Array.isArray(chatBody.tools)) {
    chatBody.tools = chatBody.tools
      .filter((t) => t && t.type === 'function')
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    if (chatBody.tools.length === 0) delete chatBody.tools;
  }
  return chatBody;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const p of content) {
    if (!p) continue;
    if (typeof p === 'string') { parts.push(p); continue; }
    if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') {
      parts.push(p.text || '');
      continue;
    }
    if (p.type === 'input_image') {
      if (p.image_url) parts.push(`[image: ${p.image_url}]`);
      else if (p.image_data) parts.push(`[image: data:${p.mime_type || 'image/png'};base64,${(p.image_data || '').slice(0, 40)}...]`);
      continue;
    }
    if (p.type === 'refusal') parts.push(`[refusal: ${p.refusal || ''}]`);
  }
  return parts.join('');
}

// ---- Response translation: Chat Completions -> Responses ----

function chatCompletionsToResponse(chatData, publicModelId, requestBody) {
  const choice = (chatData.choices && chatData.choices[0]) || {};
  const message = choice.message || {};
  const output = [];
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  for (const tc of toolCalls) {
    let args = tc.function?.arguments;
    try { args = JSON.parse(args); } catch { /* keep string */ }
    output.push({
      type: 'function_call',
      id: tc.id || `fc_${randomId()}`,
      call_id: tc.id || `call_${randomId()}`,
      name: tc.function?.name || '',
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
      status: 'completed',
    });
  }

  const reasoning = message.reasoning_content || '';
  if (reasoning) {
    output.unshift({
      type: 'reasoning',
      id: `rs_${randomId()}`,
      summary: [],
      content: [{ type: 'text', text: reasoning }],
      status: 'completed',
    });
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
    created_at: chatData.created || Math.floor(Date.now() / 1000),
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
    reasoning: reasoning ? { effort: requestBody.reasoning?.effort || 'medium' } : null,
    store: Boolean(requestBody.store),
    temperature: requestBody.temperature ?? 1,
    tool_choice: requestBody.tool_choice || 'auto',
    tools: requestBody.tools || [],
    top_p: requestBody.top_p ?? 1,
    truncation: 'disabled',
    usage: chatData.usage ? translateUsage(chatData.usage) : null,
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

// ---- Streaming transformer ----

function createResponsesStreamTransformer(publicModelId, requestBody) {
  // ONE response ID used for ALL events. This is critical: Codex rejects
  // streams where response.created and response.completed have different IDs.
  const responseId = `resp_${randomId()}`;
  const createdAt = Math.floor(Date.now() / 1000);

  const state = {
    outputIndex: 0,
    items: [],          // accumulated output items for the final response
    currentText: '',    // accumulated text for output_text
    finished: false,
    usage: null,        // captured from upstream final chunk
  };

  function emit(eventType, data) {
    // Codex parses data as JSON and looks for a `type` field. The SSE event
    // line is just a hint; the JSON type field is authoritative.
    return `event: ${eventType}\ndata: ${JSON.stringify({ type: eventType, ...data })}\n\n`;
  }

  function baseResponse(extra) {
    return {
      id: responseId,
      object: 'response',
      created_at: createdAt,
      status: 'in_progress',
      model: publicModelId,
      output: [],
      output_text: '',
      usage: null,
      ...extra,
    };
  }

  // Initial events: response.created + response.in_progress.
  // These MUST use the same responseId as everything that follows.
  const initial = [
    emit('response.created', { response: baseResponse() }),
    emit('response.in_progress', { response: baseResponse() }),
  ].join('');

  function handleDelta(chunk) {
    if (!chunk || typeof chunk !== 'object') return '';
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return '';
    const chunks = [];

    // Capture usage if upstream included it (some providers send usage in
    // the final chunk with delta = null).
    if (chunk.usage) {
      state.usage = translateUsage(chunk.usage);
    }

    // Reasoning content (DeepSeek-style).
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      let item = state.items.find((i) => i._kind === 'reasoning');
      if (!item) {
        item = {
          _kind: 'reasoning',
          type: 'reasoning',
          id: `rs_${randomId()}`,
          summary: [],
          content: [{ type: 'text', text: '' }],
          status: 'in_progress',
        };
        state.items.push(item);
        item._index = state.outputIndex++;
        const wireItem = stripInternal(item);
        chunks.push(emit('response.output_item.added', {
          output_index: item._index,
          item: wireItem,
        }));
      }
      item.content[0].text += delta.reasoning_content;
      chunks.push(emit('response.reasoning_summary_text_delta', {
        item_id: item.id,
        output_index: item._index,
        delta: delta.reasoning_content,
      }));
    }

    // Text content.
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      let item = state.items.find((i) => i._kind === 'message');
      if (!item) {
        item = {
          _kind: 'message',
          type: 'message',
          id: `msg_${randomId()}`,
          role: 'assistant',
          status: 'in_progress',
          content: [{ type: 'output_text', text: '', annotations: [] }],
        };
        state.items.push(item);
        item._index = state.outputIndex++;
        const wireItem = stripInternal(item);
        chunks.push(emit('response.output_item.added', {
          output_index: item._index,
          item: wireItem,
        }));
        chunks.push(emit('response.content_part.added', {
          item_id: item.id,
          output_index: item._index,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        }));
      }
      item.content[0].text += delta.content;
      state.currentText += delta.content;
      chunks.push(emit('response.output_text.delta', {
        item_id: item.id,
        output_index: item._index,
        content_index: 0,
        delta: delta.content,
      }));
    }

    // Tool calls.
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        let item = state.items.find((i) => i._kind === 'function_call' && i.call_id === tc.id);
        if (!item) {
          item = {
            _kind: 'function_call',
            type: 'function_call',
            id: `fc_${randomId()}`,
            call_id: tc.id || `call_${randomId()}`,
            name: tc.function?.name || '',
            arguments: '',
            status: 'in_progress',
          };
          state.items.push(item);
          item._index = state.outputIndex++;
          const wireItem = stripInternal(item);
          chunks.push(emit('response.output_item.added', {
            output_index: item._index,
            item: wireItem,
          }));
        }
        if (tc.function?.name) item.name = tc.function.name;
        if (tc.function?.arguments) {
          item.arguments += tc.function.arguments;
          chunks.push(emit('response.function_call_arguments.delta', {
            item_id: item.id,
            output_index: item._index,
            delta: tc.function.arguments,
          }));
        }
      }
    }

    return chunks.join('');
  }

  function stripInternal(item) {
    const wire = { ...item };
    delete wire._kind;
    delete wire._index;
    return wire;
  }

  function finish() {
    if (state.finished) return '';
    state.finished = true;
    const chunks = [];

    for (const item of state.items) {
      if (item._kind === 'message') {
        chunks.push(emit('response.content_part.done', {
          item_id: item.id,
          output_index: item._index,
          content_index: 0,
          part: { type: 'output_text', text: item.content[0].text, annotations: [] },
        }));
      }
      const doneItem = { ...item };
      delete doneItem._kind;
      delete doneItem._index;
      doneItem.status = 'completed';
      chunks.push(emit('response.output_item.done', {
        output_index: item._index,
        item: doneItem,
      }));
    }

    const finalOutput = state.items.map((i) => {
      const o = { ...i };
      delete o._kind;
      delete o._index;
      o.status = 'completed';
      return o;
    });

    const finalResponse = {
      id: responseId,
      object: 'response',
      created_at: createdAt,
      status: 'completed',
      background: false,
      error: null,
      incomplete_details: null,
      instructions: requestBody.instructions || null,
      max_output_tokens: requestBody.max_output_tokens ?? null,
      model: publicModelId,
      output: finalOutput,
      output_text: state.currentText,
      parallel_tool_calls: Boolean(requestBody.parallel_tool_calls),
      previous_response_id: requestBody.previous_response_id || null,
      reasoning: null,
      store: Boolean(requestBody.store),
      temperature: requestBody.temperature ?? 1,
      tool_choice: requestBody.tool_choice || 'auto',
      tools: requestBody.tools || [],
      top_p: requestBody.top_p ?? 1,
      truncation: 'disabled',
      usage: state.usage || null,
      user: requestBody.user || null,
      metadata: {},
      // Codex-specific fields. Codex parses response.completed into a
      // ResponseCompleted struct that expects `id`, `usage`, `end_turn`.
      end_turn: true,
    };

    chunks.push(emit('response.completed', { response: finalResponse }));
    chunks.push(emit('response.done', { response: finalResponse }));
    return chunks.join('');
  }

  return { initial, handleDelta, finish, responseId };
}

module.exports = {
  responsesToChatCompletions,
  chatCompletionsToResponse,
  createResponsesStreamTransformer,
};
