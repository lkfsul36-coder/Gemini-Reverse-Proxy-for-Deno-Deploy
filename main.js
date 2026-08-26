/**
 * Gemini Reverse Proxy for Deno Deploy
 * Fully stripped client headers to bypass geo-restrictions natively.
 */

const kv = await Deno.openKv();
const TARGET_HOST = "generativelanguage.googleapis.com";

Deno.serve(async (request) => {
  const url = new URL(request.url);

  // 1. Handle CORS Preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // 2. Admin Dashboard & API
  if (url.pathname === "/admin" || url.pathname === "/") {
    return renderAdminHTML();
  }
  if (url.pathname.startsWith("/api/admin/")) {
    return handleAdminAPI(request, url);
  }

  // 3. Route & Model Identification
  const isOpenAIFormat = url.pathname.startsWith("/v1/");
  let targetModel = "gemini-3.5-flash-lite";

  if (isOpenAIFormat) {
    if (url.pathname.endsWith("/models") && request.method === "GET") {
      return handleOpenAIModelsList();
    }
  } else {
    const match = url.pathname.match(/models\/([^/:]+)/);
    if (match) {
      targetModel = match[1];
    }
  }

  // 4. Retrieve Key Pool
  const keysEntry = await kv.get(["config", "keys"]);
  const keyPool = keysEntry.value ? JSON.parse(keysEntry.value) : [];

  const clientKey =
    url.searchParams.get("key") ||
    request.headers.get("x-goog-api-key") ||
    request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");

  const adminPassword = Deno.env.get("ADMIN_PASSWORD") || "1234";
  let candidateKeys = [];
  if (clientKey && clientKey !== adminPassword && clientKey !== "sk-test" && clientKey !== "sk-proxy") {
    candidateKeys.push(clientKey);
  }
  candidateKeys.push(...keyPool.filter((k) => k !== clientKey));

  if (candidateKeys.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: "No API keys configured. Add keys via /admin dashboard." } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // 5. Dispatch
  if (isOpenAIFormat && url.pathname.includes("/chat/completions")) {
    return handleOpenAIChat(request, candidateKeys, TARGET_HOST);
  }

  return handleGeminiNative(request, candidateKeys, TARGET_HOST, url, targetModel);
});

function handleOpenAIModelsList() {
  const models = [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash-lite",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3-flash",
    "gemini-2.5-flash",
  ];

  return new Response(
    JSON.stringify({
      object: "list",
      data: models.map((m) => ({
        id: m,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "google",
      })),
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

async function handleOpenAIChat(request, candidateKeys, targetHost) {
  let openAIBody;
  try {
    openAIBody = await request.json();
  } catch (_e) {
    return new Response(JSON.stringify({ error: { message: "Invalid JSON body" } }), { status: 400 });
  }

  let model = openAIBody.model || "gemini-3.5-flash-lite";
  if (model.startsWith("gemina-")) model = model.replace("gemina-", "gemini-");

  const stream = Boolean(openAIBody.stream);
  const keysToTry = await getValidKeysForModel(candidateKeys, model);
  const geminiPayload = convertOpenAIToGemini(openAIBody);
  let lastResponse = null;

  for (let i = 0; i < keysToTry.length; i++) {
    const currentKey = keysToTry[i];
    const action = stream ? "streamGenerateContent" : "generateContent";
    const targetUrl = new URL(`https://${targetHost}/v1beta/models/${model}:${action}`);
    targetUrl.searchParams.set("key", currentKey);
    if (stream) targetUrl.searchParams.set("alt", "sse");

    // Clean outbound headers without client IP/country metadata
    const cleanHeaders = {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    };

    try {
      const response = await fetch(targetUrl.toString(), {
        method: "POST",
        headers: cleanHeaders,
        body: JSON.stringify(geminiPayload),
      });

      if ([429, 403, 503].includes(response.status)) {
        await kv.set(["cooldown", currentKey.slice(-8), model], "1", { expireIn: 60000 });
        lastResponse = response;
        if (i < keysToTry.length - 1) continue;
      }

      if (!response.ok) {
        lastResponse = response;
        if (i < keysToTry.length - 1) continue;
        const errText = await response.text();
        return new Response(errText, { status: response.status, headers: { "Content-Type": "application/json" } });
      }

      recordUsage(currentKey, model);

      if (stream) {
        return new Response(transformGeminiStreamToOpenAI(response.body, model), {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
            "X-Key-Used": `...${currentKey.slice(-8)}`,
            "X-Model-Used": model,
          },
        });
      }

      const geminiData = await response.json();
      const openAIResponse = convertGeminiToOpenAI(geminiData, model);
      return new Response(JSON.stringify(openAIResponse), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "X-Key-Used": `...${currentKey.slice(-8)}`,
          "X-Model-Used": model,
        },
      });
    } catch (_err) {
      if (i < keysToTry.length - 1) continue;
    }
  }

  if (lastResponse) {
    const errText = await lastResponse.text();
    return new Response(errText, { status: lastResponse.status, headers: { "Content-Type": "application/json" } });
  }

  return new Response(
    JSON.stringify({ error: { message: `All API keys exhausted or rate-limited for model: ${model}` } }),
    { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
  );
}

function convertOpenAIToGemini(body) {
  const contents = [];
  let systemInstruction = null;

  for (const msg of body.messages || []) {
    if (msg.role === "system") {
      const sysText = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      systemInstruction = { parts: [{ text: sysText }] };
    } else {
      const role = msg.role === "assistant" ? "model" : "user";
      const parts = [];

      if (typeof msg.content === "string") {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item.type === "text") {
            parts.push({ text: item.text });
          } else if (item.type === "image_url" && item.image_url) {
            const imgUrl = item.image_url.url || "";
            if (imgUrl.startsWith("data:")) {
              const mimeMatch = imgUrl.match(/^data:([^;]+);base64,(.*)$/);
              if (mimeMatch) {
                parts.push({
                  inlineData: {
                    mimeType: mimeMatch[1],
                    data: mimeMatch[2],
                  },
                });
              }
            } else {
              parts.push({ text: `[Image URL: ${imgUrl}]` });
            }
          }
        }
      }

      if (parts.length > 0) contents.push({ role, parts });
    }
  }

  const payload = { contents };
  if (systemInstruction) payload.systemInstruction = systemInstruction;

  const config = {};
  if (body.temperature !== undefined) config.temperature = body.temperature;
  if (body.top_p !== undefined) config.topP = body.top_p;
  if (body.max_tokens !== undefined) config.maxOutputTokens = body.max_tokens;
  if (Object.keys(config).length > 0) payload.generationConfig = config;

  return payload;
}

function convertGeminiToOpenAI(geminiData, model) {
  const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return {
    id: "chatcmpl-" + Math.random().toString(36).substring(2, 12),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: geminiData.usageMetadata?.promptTokenCount || 0,
      completion_tokens: geminiData.usageMetadata?.candidatesTokenCount || 0,
      total_tokens: geminiData.usageMetadata?.totalTokenCount || 0,
    },
  };
}

function transformGeminiStreamToOpenAI(geminiStream, model) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = geminiStream.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const chatId = "chatcmpl-" + Math.random().toString(36).substring(2, 12);
  let buffer = "";

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const rawJson = line.slice(6).trim();
            if (!rawJson || rawJson === "[DONE]") continue;

            try {
              const parsed = JSON.parse(rawJson);
              const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) {
                const chunk = {
                  id: chatId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: model,
                  choices: [
                    {
                      index: 0,
                      delta: { content: text },
                      finish_reason: null,
                    },
                  ],
                };
                await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
            } catch (_e) {}
          }
        }
      }
      await writer.write(encoder.encode("data: [DONE]\n\n"));
    } catch (err) {
      console.error(err);
    } finally {
      writer.close();
    }
  })();

  return readable;
}

async function getValidKeysForModel(candidateKeys, model) {
  const validKeys = [];
  for (const key of candidateKeys) {
    const isCooldown = await kv.get(["cooldown", key.slice(-8), model]);
    if (!isCooldown.value) validKeys.push(key);
  }
  return validKeys.length > 0 ? validKeys : candidateKeys;
}

async function handleGeminiNative(request, candidateKeys, targetHost, url, modelName) {
  const isModelsListQuery = url.pathname.endsWith("/models") || url.pathname.endsWith("/models/");
  const keysToTry = await getValidKeysForModel(candidateKeys, modelName);

  let bodyBuffer = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    bodyBuffer = await request.arrayBuffer();
  }

  let lastResponse = null;

  for (let i = 0; i < keysToTry.length; i++) {
    const currentKey = keysToTry[i];
    const targetUrl = new URL(request.url);
    targetUrl.hostname = targetHost;
    targetUrl.protocol = "https:";
    targetUrl.port = "";
    targetUrl.searchParams.set("key", currentKey);

    // Strip client headers (x-forwarded-for, cf-connecting-ip, etc.)
    const cleanHeaders = new Headers();
    const contentType = request.headers.get("content-type");
    if (contentType) cleanHeaders.set("Content-Type", contentType);
    cleanHeaders.set("x-goog-api-key", currentKey);
    cleanHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");

    const targetRequest = new Request(targetUrl.toString(), {
      method: request.method,
      headers: cleanHeaders,
      body: bodyBuffer ? bodyBuffer.slice(0) : null,
      redirect: "follow",
    });

    try {
      const response = await fetch(targetRequest);

      if ([429, 403, 503].includes(response.status)) {
        await kv.set(["cooldown", currentKey.slice(-8), modelName], "1", { expireIn: 60000 });
        lastResponse = response;
        if (i < keysToTry.length - 1) continue;
      }

      const resHeaders = new Headers(response.headers);
      resHeaders.set("Access-Control-Allow-Origin", "*");
      resHeaders.set("X-Key-Used", `...${currentKey.slice(-8)}`);

      if (response.ok && !isModelsListQuery) {
        recordUsage(currentKey, modelName);
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: resHeaders,
      });
    } catch (_err) {
      if (i < keysToTry.length - 1) continue;
    }
  }

  if (lastResponse) {
    const resHeaders = new Headers(lastResponse.headers);
    resHeaders.set("Access-Control-Allow-Origin", "*");
    return new Response(lastResponse.body, { status: lastResponse.status, headers: resHeaders });
  }

  return new Response(JSON.stringify({ error: "All keys exhausted or network error occurred" }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });
}

async function recordUsage(key, model) {
  const today = new Date().toISOString().split("T")[0];
  const keyTail = key.slice(-8);

  await incrementKV(["usage", "key", keyTail, "today", today]);
  await incrementKV(["usage", "key", keyTail, "total"]);
  await incrementKV(["usage", "model", model, "today", today]);
  await incrementKV(["usage", "model", model, "total"]);

  await appendIndex(["index", "keys"], keyTail);
  await appendIndex(["index", "models"], model);
}

async function incrementKV(keyPath) {
  const res = await kv.get(keyPath);
  const current = parseInt(res.value || "0", 10);
  await kv.set(keyPath, (current + 1).toString());
}

async function appendIndex(keyPath, item) {
  const res = await kv.get(keyPath);
  let list = res.value ? JSON.parse(res.value) : [];
  if (!list.includes(item)) {
    list.push(item);
    await kv.set(keyPath, JSON.stringify(list));
  }
}

async function handleAdminAPI(request, url) {
  const auth = request.headers.get("Authorization");
  const expectedAuth = `Bearer ${Deno.env.get("ADMIN_PASSWORD") || "1234"}`;

  if (!auth || auth !== expectedAuth) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (url.pathname === "/api/admin/data" && request.method === "GET") {
    const today = new Date().toISOString().split("T")[0];
    const rawKeys = (await kv.get(["config", "keys"])).value || "[]";
    const keyPool = JSON.parse(rawKeys);
    const modelsList = JSON.parse((await kv.get(["index", "models"])).value || "[]");

    const keyStats = [];
    for (const fullKey of keyPool) {
      const tail = fullKey.slice(-8);
      const todayCount = (await kv.get(["usage", "key", tail, "today", today])).value || "0";
      const totalCount = (await kv.get(["usage", "key", tail, "total"])).value || "0";
      keyStats.push({
        key: fullKey,
        masked: `...${tail}`,
        today: parseInt(todayCount, 10),
        total: parseInt(totalCount, 10),
      });
    }

    const modelStats = [];
    for (const m of modelsList) {
      const todayCount = (await kv.get(["usage", "model", m, "today", today])).value || "0";
      const totalCount = (await kv.get(["usage", "model", m, "total"])).value || "0";
      modelStats.push({
        model: m,
        today: parseInt(todayCount, 10),
        total: parseInt(totalCount, 10),
      });
    }

    return new Response(
      JSON.stringify({ date: today, keys: keyStats, models: modelStats }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  if (url.pathname === "/api/admin/keys" && request.method === "POST") {
    const body = await request.json();
    if (Array.isArray(body.keys)) {
      await kv.set(["config", "keys"], JSON.stringify(body.keys));
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  return new Response(JSON.stringify({ error: "Not Found" }), { status: 404 });
}

function renderAdminHTML() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Gemini API Proxy Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen p-6 font-sans">
  <div class="max-w-5xl mx-auto space-y-6">
    <div class="flex flex-col md:flex-row justify-between md:items-center bg-slate-800 p-6 rounded-2xl border border-slate-700 gap-4 shadow-lg">
      <div>
        <h1 class="text-2xl font-bold text-sky-400">Gemini Proxy (Deno Deploy)</h1>
        <p class="text-sm text-slate-400 mt-1">Direct Edge Relay · Multi-key Rotation · Header Stripping</p>
      </div>
      <div class="flex gap-2">
        <input id="pwdInput" type="password" placeholder="Admin Password" class="bg-slate-950 border border-slate-700 px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-sky-500">
        <button onclick="fetchData()" class="bg-sky-600 hover:bg-sky-500 px-4 py-2 rounded-lg text-sm font-semibold transition">Login / Refresh</button>
      </div>
    </div>

    <!-- Client Endpoints Card -->
    <div class="bg-slate-800/90 p-5 rounded-2xl border border-sky-900/60 shadow-md">
      <h2 class="text-sm font-semibold text-sky-400 mb-3">🔗 Client Endpoints (Base URL)</h2>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
        <div class="bg-slate-950/80 p-3.5 rounded-xl border border-slate-700 flex flex-col justify-between">
          <div>
            <div class="flex justify-between items-center mb-1">
              <span class="text-slate-400 font-medium">OpenAI Compatible (Cline, Roo Code, Continue)</span>
              <button onclick="copyToClip('openaiUrl', this)" class="text-sky-400 hover:text-sky-300 font-medium">Copy</button>
            </div>
            <div id="openaiUrl" class="font-mono text-emerald-400 text-sm break-all select-all">Loading...</div>
          </div>
          <div class="text-[11px] text-slate-500 mt-2">API Key: Any string (e.g. sk-proxy)</div>
        </div>
        <div class="bg-slate-950/80 p-3.5 rounded-xl border border-slate-700 flex flex-col justify-between">
          <div>
            <div class="flex justify-between items-center mb-1">
              <span class="text-slate-400 font-medium">Gemini Native Endpoint (SDK)</span>
              <button onclick="copyToClip('geminiUrl', this)" class="text-sky-400 hover:text-sky-300 font-medium">Copy</button>
            </div>
            <div id="geminiUrl" class="font-mono text-emerald-400 text-sm break-all select-all">Loading...</div>
          </div>
          <div class="text-[11px] text-slate-500 mt-2">Supports native Google Gemini REST</div>
        </div>
      </div>
    </div>

    <!-- Model Usage Metrics -->
    <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-md">
      <h2 class="text-lg font-semibold text-slate-200 mb-4">📊 Model Usage Metrics</h2>
      <div id="modelList" class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="text-slate-500 text-sm">Please login and refresh to view metrics...</div>
      </div>
    </div>

    <!-- API Key Pool Table -->
    <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-md">
      <div class="flex justify-between items-center mb-4">
        <h2 class="text-lg font-semibold text-slate-200">🔑 API Key Pool & Quotas</h2>
        <button onclick="addKeyPrompt()" class="bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 rounded-lg text-sm font-semibold transition">+ Add Key</button>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="text-slate-400 border-b border-slate-700">
            <tr>
              <th class="py-2">Key Mask</th>
              <th class="py-2">Today</th>
              <th class="py-2">Total</th>
              <th class="py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody id="keyTableBody" class="divide-y divide-slate-700/50">
            <tr><td colspan="4" class="py-4 text-center text-slate-500">No keys configured yet</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    let currentKeys = [];

    function initBaseUrls() {
      const origin = window.location.origin;
      document.getElementById('openaiUrl').innerText = origin + '/v1';
      document.getElementById('geminiUrl').innerText = origin;
    }

    function copyToClip(elemId, btn) {
      const text = document.getElementById(elemId).innerText;
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.innerText;
        btn.innerText = 'Copied!';
        btn.classList.add('text-emerald-400');
        setTimeout(() => {
          btn.innerText = orig;
          btn.classList.remove('text-emerald-400');
        }, 1500);
      });
    }

    function getAuth() {
      const pwd = document.getElementById('pwdInput').value || localStorage.getItem('deno_proxy_pwd') || '';
      if(pwd) localStorage.setItem('deno_proxy_pwd', pwd);
      return 'Bearer ' + pwd;
    }

    window.onload = () => {
      initBaseUrls();
      const saved = localStorage.getItem('deno_proxy_pwd');
      if(saved) document.getElementById('pwdInput').value = saved;
      fetchData();
    };

    async function fetchData() {
      try {
        const res = await fetch('/api/admin/data', {
          headers: { 'Authorization': getAuth() }
        });
        if(res.status === 401) return alert('Invalid or missing admin password!');
        const data = await res.json();
        renderModels(data.models);
        renderKeys(data.keys);
      } catch(e) {
        console.error(e);
      }
    }

    function renderModels(models) {
      const box = document.getElementById('modelList');
      if(!models || models.length === 0) {
        box.innerHTML = '<div class="text-slate-500 text-sm">No model usage recorded yet.</div>';
        return;
      }
      box.innerHTML = models.map(m => \`
        <div class="bg-slate-900/60 p-4 rounded-xl border border-slate-700/50">
          <div class="text-sm font-semibold text-slate-300 truncate" title="\${m.model}">\${m.model}</div>
          <div class="flex justify-between mt-3 text-xs">
            <span class="text-slate-400">Today: <b class="text-emerald-400 text-sm">\${m.today}</b></span>
            <span class="text-slate-400">Total: <b class="text-sky-400 text-sm">\${m.total}</b></span>
          </div>
        </div>
      \`).join('');
    }

    function renderKeys(keys) {
      currentKeys = keys ? keys.map(k => k.key) : [];
      const tbody = document.getElementById('keyTableBody');
      if(!keys || keys.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="py-4 text-center text-slate-500">Key pool is empty. Click "+ Add Key" to add one.</td></tr>';
        return;
      }
      tbody.innerHTML = keys.map((k, idx) => \`
        <tr class="hover:bg-slate-700/30 transition">
          <td class="py-3 font-mono text-slate-300">\${k.masked}</td>
          <td class="py-3 text-emerald-400 font-semibold">\${k.today}</td>
          <td class="py-3 text-sky-400 font-semibold">\${k.total}</td>
          <td class="py-3 text-right">
            <button onclick="deleteKey(\${idx})" class="text-rose-400 hover:text-rose-300 text-xs font-medium">Delete</button>
          </td>
        </tr>
      \`).join('');
    }

    async function addKeyPrompt() {
      const key = prompt('Enter your full Gemini API Key (e.g. AIzaSy...):');
      if(!key || !key.trim()) return;
      currentKeys.push(key.trim());
      await saveKeys();
    }

    async function deleteKey(index) {
      if(!confirm('Are you sure you want to remove this API Key?')) return;
      currentKeys.splice(index, 1);
      await saveKeys();
    }

    async function saveKeys() {
      await fetch('/api/admin/keys', {
        method: 'POST',
        headers: { 'Authorization': getAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: currentKeys })
      });
      fetchData();
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
