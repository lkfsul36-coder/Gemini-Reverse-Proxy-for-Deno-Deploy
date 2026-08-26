/**
 * Gemini Reverse Proxy for Deno Deploy
 * Uses Google Official OpenAI Compatibility Layer + Native KV & Admin Panel
 */

const kv = await Deno.openKv();
const TARGET_HOST = "generativelanguage.googleapis.com";

Deno.serve(async (request) => {
  const url = new URL(request.url);

  // 1. CORS Preflight
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

  // 2. Admin Panel
  if (url.pathname === "/admin" || url.pathname === "/") {
    return renderAdminHTML();
  }
  if (url.pathname.startsWith("/api/admin/")) {
    return handleAdminAPI(request, url);
  }

  // 3. Retrieve Key Pool
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

  // 4. Forwarding Logic
  let targetPath = url.pathname;
  let targetModel = "gemini-2.5-flash";

  let bodyBuffer = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    bodyBuffer = await request.arrayBuffer();
    try {
      const parsedBody = JSON.parse(new TextDecoder().decode(bodyBuffer));
      if (parsedBody.model) {
        targetModel = parsedBody.model;
      }
    } catch (_e) {}
  }

  // Route OpenAI format directly to Google's official OpenAI compat layer
  if (url.pathname.startsWith("/v1/")) {
    targetPath = "/v1beta/openai" + url.pathname;
  }

  const keysToTry = candidateKeys;
  let lastResponse = null;

  for (let i = 0; i < keysToTry.length; i++) {
    const currentKey = keysToTry[i];
    const targetUrl = new URL(`https://${TARGET_HOST}${targetPath}${url.search}`);
    targetUrl.searchParams.set("key", currentKey);

    // Completely clean request headers to avoid regional blocking
    const cleanHeaders = new Headers();
    const contentType = request.headers.get("content-type");
    if (contentType) cleanHeaders.set("Content-Type", contentType);
    cleanHeaders.set("Authorization", `Bearer ${currentKey}`);
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
        lastResponse = response;
        if (i < keysToTry.length - 1) continue;
      }

      const resHeaders = new Headers(response.headers);
      resHeaders.set("Access-Control-Allow-Origin", "*");
      resHeaders.set("X-Key-Used", `...${currentKey.slice(-8)}`);

      if (response.ok && !url.pathname.endsWith("/models")) {
        recordUsage(currentKey, targetModel);
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
});

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
      keyStats.push({ key: fullKey, masked: `...${tail}`, today: parseInt(todayCount, 10), total: parseInt(totalCount, 10) });
    }

    const modelStats = [];
    for (const m of modelsList) {
      const todayCount = (await kv.get(["usage", "model", m, "today", today])).value || "0";
      const totalCount = (await kv.get(["usage", "model", m, "total"])).value || "0";
      modelStats.push({ model: m, today: parseInt(todayCount, 10), total: parseInt(totalCount, 10) });
    }

    return new Response(JSON.stringify({ date: today, keys: keyStats, models: modelStats }), { headers: { "Content-Type": "application/json" } });
  }

  if (url.pathname === "/api/admin/keys" && request.method === "POST") {
    const body = await request.json();
    if (Array.isArray(body.keys)) {
      await kv.set(["config", "keys"], JSON.stringify(body.keys));
      return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
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
        <p class="text-sm text-slate-400 mt-1">Official Native OpenAI Relay · Zero Data Loss</p>
      </div>
      <div class="flex gap-2">
        <input id="pwdInput" type="password" placeholder="Admin Password" class="bg-slate-950 border border-slate-700 px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-sky-500">
        <button onclick="fetchData()" class="bg-sky-600 hover:bg-sky-500 px-4 py-2 rounded-lg text-sm font-semibold transition">Login / Refresh</button>
      </div>
    </div>
    <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-md">
      <h2 class="text-lg font-semibold text-slate-200 mb-4">📊 Model Usage Metrics</h2>
      <div id="modelList" class="grid grid-cols-1 md:grid-cols-3 gap-4"><div class="text-slate-500 text-sm">Please login...</div></div>
    </div>
    <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-md">
      <div class="flex justify-between items-center mb-4">
        <h2 class="text-lg font-semibold text-slate-200">🔑 API Key Pool</h2>
        <button onclick="addKeyPrompt()" class="bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 rounded-lg text-sm font-semibold transition">+ Add Key</button>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="text-slate-400 border-b border-slate-700">
            <tr><th class="py-2">Key Mask</th><th class="py-2">Today</th><th class="py-2">Total</th><th class="py-2 text-right">Actions</th></tr>
          </thead>
          <tbody id="keyTableBody" class="divide-y divide-slate-700/50"><tr><td colspan="4" class="py-4 text-center text-slate-500">Empty</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
  <script>
    let currentKeys = [];
    function getAuth() {
      const pwd = document.getElementById('pwdInput').value || localStorage.getItem('deno_proxy_pwd') || '';
      if(pwd) localStorage.setItem('deno_proxy_pwd', pwd);
      return 'Bearer ' + pwd;
    }
    window.onload = () => {
      const saved = localStorage.getItem('deno_proxy_pwd');
      if(saved) document.getElementById('pwdInput').value = saved;
      fetchData();
    };
    async function fetchData() {
      try {
        const res = await fetch('/api/admin/data', { headers: { 'Authorization': getAuth() } });
        if(res.status === 401) return alert('Invalid password');
        const data = await res.json();
        renderModels(data.models);
        renderKeys(data.keys);
      } catch(e) { console.error(e); }
    }
    function renderModels(models) {
      const box = document.getElementById('modelList');
      if(!models || models.length === 0) { box.innerHTML = '<div class="text-slate-500 text-sm">No usage yet.</div>'; return; }
      box.innerHTML = models.map(m => \`<div class="bg-slate-900/60 p-4 rounded-xl border border-slate-700/50"><div class="text-sm font-semibold text-slate-300 truncate">\${m.model}</div><div class="flex justify-between mt-3 text-xs"><span class="text-slate-400">Today: <b class="text-emerald-400">\${m.today}</b></span><span class="text-slate-400">Total: <b class="text-sky-400">\${m.total}</b></span></div></div>\`).join('');
    }
    function renderKeys(keys) {
      currentKeys = keys ? keys.map(k => k.key) : [];
      const tbody = document.getElementById('keyTableBody');
      if(!keys || keys.length === 0) { tbody.innerHTML = '<tr><td colspan="4" class="py-4 text-center text-slate-500">No keys.</td></tr>'; return; }
      tbody.innerHTML = keys.map((k, idx) => \`<tr class="hover:bg-slate-700/30 transition"><td class="py-3 font-mono">\${k.masked}</td><td class="py-3 text-emerald-400 font-semibold">\${k.today}</td><td class="py-3 text-sky-400 font-semibold">\${k.total}</td><td class="py-3 text-right"><button onclick="deleteKey(\${idx})" class="text-rose-400 hover:text-rose-300 text-xs">Delete</button></td></tr>\`).join('');
    }
    async function addKeyPrompt() {
      const key = prompt('Enter full Gemini API Key:');
      if(!key || !key.trim()) return;
      currentKeys.push(key.trim());
      await saveKeys();
    }
    async function deleteKey(index) {
      if(!confirm('Delete key?')) return;
      currentKeys.splice(index, 1);
      await saveKeys();
    }
    async function saveKeys() {
      await fetch('/api/admin/keys', { method: 'POST', headers: { 'Authorization': getAuth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: currentKeys }) });
      fetchData();
    }
  </script>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
