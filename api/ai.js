/* Vercel Serverless Function：HiBetter AI 助手代理
 *
 * 作用：把前端的对话/工具请求转发给 DeepSeek，密钥只在服务端注入
 *  - 密钥来源：环境变量 DEEPSEEK_KEY（Vercel / 本地环境变量）
 *  - 模型：deepseek-flash，推理等级 low（reasoning_effort: low）
 *  - 支持 tools（function calling）：AI 可返回工具调用，由前端执行后回传结果
 * 请求体：{ messages, tools?, tool_choice?, temperature?, max_tokens? }
 * 响应体：{ ok, message, tool_calls, usage }
 */
const DS_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = process.env.AI_MODEL || 'deepseek-flash'; // 可切换为 deepseek-v4-pro

/** 清洗历史：确保 assistant(tool_calls) 与紧随其后的 tool 响应严格配对，
 *  否则 DeepSeek 会返回 400（悬空 tool_calls 是常见原因）。 */
function sanitizeMessages(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || !m.role) continue;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const need = m.tool_calls.map(tc => tc.id);
      const got = [];
      let j = i + 1;
      while (j < list.length && list[j] && list[j].role === 'tool') { got.push(list[j].tool_call_id); j++; }
      const okPair = need.every(id => got.indexOf(id) >= 0);
      if (!okPair) continue; // 悬空调用：整条丢弃（含其 tool 响应）
      out.push({
        role: 'assistant',
        content: m.content || '',
        tool_calls: m.tool_calls.map(tc => ({
          id: tc.id, type: 'function',
          function: { name: tc.function && tc.function.name, arguments: tc.function && tc.function.arguments },
        })),
      });
      for (let k = i + 1; k < j; k++) {
        out.push({ role: 'tool', tool_call_id: list[k].tool_call_id, content: String(list[k].content == null ? '' : list[k].content) });
      }
      i = j - 1;
    } else if (m.role === 'tool') {
      continue; // 无前置 tool_calls 的孤立 tool 响应：丢弃
    } else {
      out.push({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content == null ? '' : m.content) });
    }
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, msg: 'method not allowed' });
  const key = (process.env.DEEPSEEK_KEY || '').trim();
  if (!key) return res.status(503).json({ ok: false, msg: 'AI 未配置（缺少 DEEPSEEK_KEY）' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || !Array.isArray(body.messages)) return res.status(400).json({ ok: false, msg: 'bad body' });

  // 用户自定义模型配置（可选）：优先使用用户自己的地址/密钥/模型
  const custom = body.custom || null;
  const wantsCustom = !!(custom && (String(custom.baseUrl || '').trim() || String(custom.model || '').trim()));
  if (wantsCustom && !String(custom.apiKey || '').trim()) {
    return res.status(400).json({ ok: false, msg: '自定义模型必须填写你自己的 API Key（不能使用本站内置密钥）' });
  }
  const useKey = (custom && custom.apiKey) ? String(custom.apiKey).trim() : key;
  let useUrl = (custom && custom.baseUrl) ? String(custom.baseUrl).trim() : DS_URL;
  if (!/^https?:\/\//i.test(useUrl)) return res.status(400).json({ ok: false, msg: 'API 网址需以 http(s):// 开头' });
  if (useUrl.indexOf('/chat/completions') < 0) useUrl = useUrl.replace(/\/+$/, '') + '/chat/completions';
  const useModel = (custom && custom.model) ? String(custom.model).trim() : MODEL;
  const payload = {
    model: useModel,
    messages: sanitizeMessages(sanitizeMessages(body.messages.slice(-30)).slice(-24)), // 清洗→限长→再清洗（截断不破坏配对）
    reasoning_effort: (function () {
      const e = (custom && custom.effort) ? String(custom.effort).trim() : '';
      if (!e) return process.env.AI_EFFORT || 'low';
      return e === 'off' ? 'none' : e; // off → none（DeepSeek 关闭推理的写法）
    })(), // 推理等级（按用户所选档位）
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
    max_tokens: Math.min(2048, body.max_tokens || 900),
  };
  if (Array.isArray(body.tools) && body.tools.length) {
    payload.tools = body.tools;
    payload.tool_choice = body.tool_choice || 'auto';
  }

  try {
    const r = await fetch(useUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + useKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({ ok: false, msg: (j && j.error && j.error.message) || ('HTTP ' + r.status) });
    }
    const choice = (j.choices && j.choices[0]) || {};
    const msg = choice.message || {};
    return res.status(200).json({
      ok: true,
      message: { role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls || null, reasoning: msg.reasoning_content || '' },
      finish_reason: choice.finish_reason || '',
      usage: j.usage || null,
    });
  } catch (e) {
    return res.status(502).json({ ok: false, msg: e.message || 'upstream error' });
  }
}
