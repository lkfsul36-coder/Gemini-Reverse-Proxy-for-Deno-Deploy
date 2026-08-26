/**
 * Production Proxy for Deno Deploy with Live 429 Cooldown Countdown & AI Studio Quota Monitor
 * Providers: Google Gemini & Agnes AI
 * Features:
 *  - Live Dynamic Countdown for 429 Cooldowns (Front-end & Server-side timestamp validation)
 *  - 3-Dimension Rate Limit Monitor: RPM, TPM, RPD
 *  - Virtual Fallback Model: mixed-lite (agnes-2.5-flash -> gemini-3.5-flash-lite -> gemini-3.0-flash -> gemini-2.5-flash -> gemini-2.0-flash)
 *  - Atomic KV Analytics & Geo-Bypass Header Scrubbing
 */

const kv = await Deno.openKv();
const GOOGLE_TARGET_HOST = "generativelanguage.googleapis.com";
const DEFAULT_AGNES_HOST = Deno.env.get("AGNES_HOST") || "api.agnes.ai";
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD") || "1234";

const MODEL_CATALOG = {
  "mixed-lite": {
    name: "Mixed-Lite (Virtual Auto-Failover)",
    provider: "virtual",
    rpmLimit: "Adaptive (10-30)",
    tpmLimit: "250K - 1M",
    rpdLimit: "Aggregated (250+)",
    desc: "Auto failover chain: Agnes 2.5 Flash -> Gemini 3.5 Lite -> 3.0 -> 2.5 -> 2.0",
  },
  "agnes-2.5-flash": {
    name: "Agnes 2.5 Flash",
    provider: "agnes",
    rpmLimit: 10,
    tpmLimit: "250,000",
    rpdLimit: 250,
    desc: "Agnes Multimodal Flagship (10 RPM / 250 RPD enforced)",
  },
  "gemini-3.5-flash-lite": {
    name: "Gemini 3.5 Flash-Lite",
    provider: "gemini",
    rpmLimit: 30,
    tpmLimit: "1,000,000",
    rpdLimit: 1500,
    desc: "Ultra lightweight high-concurrency model",
  },
  "gemini-3.0-flash": {
    name: "Gemini 3.0 Flash",
    provider: "gemini",
    rpmLimit: 15,
    tpmLimit: "1,000,000",
    rpdLimit: 1500,
    desc: "Gemini 3.0 balanced reasoning model",
  },
  "gemini-2.5-flash": {
    name: "Gemini 2.5 Flash",
    provider: "gemini",
    rpmLimit: 15,
    tpmLimit: "1,000,000",
    rpdLimit: 1500,
    desc: "Workhorse model with long context & tool calling",
  },
  "gemini-2.0-flash": {
    name: "Gemini 2.0 Flash",
    provider: "gemini",
    rpmLimit: 15,
    tpmLimit: "1,000,000",
    rpdLimit: 1500,
    desc: "High-compatibility fast fallback model",
  },
};

const MIXED_LITE_CHAIN = [
  { provider: "agnes", model: "agnes-2.5-flash" },
  { provider: "gemini", model: "gemini-3.5-flash-lite" },
  { provider: "gemini", model: "gemini-3.0-flash" },
  { provider: "gemini", model: "gemini-2.5-flash" },
  { provider: "gemini", model: "gemini-2.0-flash" },
];

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

  // 2. Dashboard & API Endpoints
  if (url.pathname === "/admin" || url.pathname === "/") {
    return renderAdminHTML();
  }
  if (url.pathname.startsWith("/api/admin/")) {
    return handleAdminAPI(request, url);
  }

  // 3. /v1/models
  if (url.pathname === "/v1/models" && request.method === "GET") {
    return handleModelsList();
  }

  // 4. Parse Request
  let bodyBuffer = null;
  let requestedModel = "mixed-lite";
  let requestJson = null;

  if (request.method !== "GET" && request.method !== "HEAD") {
    bodyBuffer = await request.arrayBuffer();
    try {
      requestJson = JSON.parse(new TextDecoder().decode(bodyBuffer));
      if (requestJson.model) requestedModel = requestJson.model;
    } catch (_e) {}
  }

  // 5. Model Routing
  if (requestedModel === "mixed-lite") {
    return await executeMixedLiteChain(request, url, requestJson);
  }

  const isAgnes = requestedModel.toLowerCase().startsWith("agnes");
  const provider = isAgnes ? "agnes" : "gemini";
  return await executeSingleModel(request, url, bodyBuffer, requestedModel, provider);
});

async function executeMixedLiteChain(request, url, requestJson) {
  let lastResponse = null;

  for (const step of MIXED_LITE_CHAIN) {
    const activeJson = requestJson ? { ...requestJson, model: step.model } : null;
    const bodyBuffer = activeJson ? new TextEncoder().encode(JSON.stringify(activeJson)) : null;

    const res = await attemptForward(request, url, bodyBuffer, step.model, step.provider, true);
    if (res && res.ok) {
      const resHeaders = new Headers(res.headers);
      resHeaders.set("X-Virtual-Model", "mixed-lite");
      resHeaders.set("X-Resolved-Model", step.model);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: resHeaders });
    }
    if (res) lastResponse = res;
  }

  if (lastResponse) return lastResponse;

  return new Response(
    JSON.stringify({
      error: {
        message: "All fallback tiers for [mixed-lite] have been exhausted. Please verify API keys in /admin.",
      },
    }),
    { status: 429, headers: { "Content-Type": "application/json" } }
  );
}

async function executeSingleModel(request, url, bodyBuffer, targetModel, provider) {
  const res = await attemptForward(request, url, bodyBuffer, targetModel, provider, false);
  if (res) return res;

  return new Response(
    JSON.stringify({
      error: {
        message: `All keys for model [${targetModel}] have reached the limit or are cooling down.`,
      },
    }),
    { status: 429, headers: { "Content-Type": "application/json" } }
  );
}

async function attemptForward(request, url, bodyBuffer, targetModel, provider, isFallbackMode) {
  const now = Date.now();
  const today = new Date().toISOString().split("T")[0];
  const currentMinute = Math.floor(now / 60000);

  const keysEntry = await kv.get(["config", "keys", provider]);
  const keyPool = keysEntry.value ? JSON.parse(keysEntry.value) : [];

  const clientKey =
    url.searchParams.get("key") ||
    request.headers.get("x-goog-api-key") ||
    request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");

  let candidateKeys = [];
  if (clientKey && clientKey !== ADMIN_PASSWORD && clientKey !== "sk-test" && clientKey !== "sk-proxy") {
    candidateKeys.push(clientKey);
  }
  const shuffledPool = [...keyPool.filter((k) => k !== clientKey)].sort(() => Math.random() - 0.5);
  candidateKeys.push(...shuffledPool);

  if (candidateKeys.length === 0) return null;

  // Filter keys by validating cooldown timestamp and quotas
  const usableKeys = [];
  for (const k of candidateKeys) {
    const tail = k.slice(-8);
    const cooldownEntry = await kv.get(["cooldown_until", tail]);
    const cooldownUntil = parseInt(cooldownEntry.value || "0", 10);

    // Active cooldown check: lock only if timestamp is in the future
    if (cooldownUntil > now) continue;

    if (provider === "agnes") {
      const rpdCount = parseInt((await kv.get(["usage", "agnes", "key", tail, "today", today])).value || "0", 10);
      if (rpdCount >= 250) continue;

      const rpmCount = parseInt((await kv.get(["rpm", "agnes", tail, currentMinute])).value || "0", 10);
      if (rpmCount >= 10) continue;
    }
    usableKeys.push(k);
  }

  if (usableKeys.length === 0) return null;

  const targetHost = provider === "agnes" ? DEFAULT_AGNES_HOST : GOOGLE_TARGET_HOST;
  let targetPath = url.pathname;
  if (provider === "gemini" && url.pathname.startsWith("/v1/")) {
    targetPath = "/v1beta/openai" + url.pathname;
  }

  for (let i = 0; i < usableKeys.length; i++) {
    const currentKey = usableKeys[i];
    const tail = currentKey.slice(-8);
    const targetUrl = new URL(`https://${targetHost}${targetPath}${url.search}`);
    if (provider !== "agnes") targetUrl.searchParams.set("key", currentKey);

    const cleanHeaders = new Headers();
    const contentType = request.headers.get("content-type");
    if (contentType) cleanHeaders.set("Content-Type", contentType);
    cleanHeaders.set("Authorization", `Bearer ${currentKey}`);
    if (provider !== "agnes") cleanHeaders.set("x-goog-api-key", currentKey);
    cleanHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    cleanHeaders.set("Accept-Encoding", "identity");

    const targetReq = new Request(targetUrl.toString(), {
      method: request.method,
      headers: cleanHeaders,
      body: bodyBuffer ? bodyBuffer.slice(0) : null,
      redirect: "follow",
    });

    try {
      const response = await fetch(targetReq);

      if ([429, 403, 503].includes(response.status)) {
        // Store explicit epoch timestamp for 60s cooldown
        const unlockTime = Date.now() + 60000;
        await kv.set(["cooldown_until", tail], unlockTime.toString(), { expireIn: 65000 });
        if (i < usableKeys.length - 1) continue;
        if (isFallbackMode) return null;
      }

      const resHeaders = new Headers(response.headers);
      resHeaders.set("Access-Control-Allow-Origin", "*");
      resHeaders.set("X-Key-Used", `...${tail}`);
      resHeaders.set("X-Provider-Used", provider);
      resHeaders.delete("content-encoding");

      if (response.ok) {
        const estimatedTokens = 800;
        recordUsageAtomic(provider, currentKey, targetModel, estimatedTokens);

        const rpmKey = ["rpm", provider, tail, currentMinute];
        const curRPM = parseInt((await kv.get(rpmKey)).value || "0", 10);
        await kv.set(rpmKey, (curRPM + 1).toString(), { expireIn: 120000 });

        const tpmKey = ["tpm", provider, tail, currentMinute];
        const curTPM = parseInt((await kv.get(tpmKey)).value || "0", 10);
        await kv.set(tpmKey, (curTPM + estimatedTokens).toString(), { expireIn: 120000 });
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: resHeaders,
      });
    } catch (_err) {
      if (i < usableKeys.length - 1) continue;
    }
  }

  return null;
}

function handleModelsList() {
  const list = Object.keys(MODEL_CATALOG).map((id) => ({
    id: id,
    object: "model",
    created: 1717000000,
    owned_by: MODEL_CATALOG[id].provider,
  }));
  return new Response(JSON.stringify({ object: "list", data: list }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

async function recordUsageAtomic(provider, key, model, tokens) {
  const today = new Date().toISOString().split("T")[0];
  const keyTail = key.slice(-8);

  const kToday = ["usage", provider, "key", keyTail, "today", today];
  const kTotal = ["usage", provider, "key", keyTail, "total"];
  const mToday = ["usage", provider, "model", model, "today", today];
  const mTotal = ["usage", provider, "model", model, "total"];
  const mTokensToday = ["tokens", provider, "model", model, "today", today];

  const [resKT, resKAll, resMT, resMAll, resToken] = await kv.getMany([kToday, kTotal, mToday, mTotal, mTokensToday]);

  await kv.atomic()
    .set(kToday, (parseInt(resKT.value || "0", 10) + 1).toString())
    .set(kTotal, (parseInt(resKAll.value || "0", 10) + 1).toString())
    .set(mToday, (parseInt(resMT.value || "0", 10) + 1).toString())
    .set(mTotal, (parseInt(resMAll.value || "0", 10) + 1).toString())
    .set(mTokensToday, (parseInt(resToken.value || "0", 10) + tokens).toString())
    .commit();

  await appendIndex(["index", provider, "keys"], keyTail);
  await appendIndex(["index", provider, "models"], model);
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
  if (!auth || auth !== `Bearer ${ADMIN_PASSWORD}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (url.pathname === "/api/admin/data" && request.method === "GET") {
    const now = Date.now();
    const today = new Date().toISOString().split("T")[0];
    const currentMinute = Math.floor(now / 60000);

    const getStats = async (provider) => {
      const rawKeys = (await kv.get(["config", "keys", provider])).value || "[]";
      const keyPool = JSON.parse(rawKeys);

      const keyStats = [];
      for (const fullKey of keyPool) {
        const tail = fullKey.slice(-8);
        const todayCount = parseInt((await kv.get(["usage", provider, "key", tail, "today", today])).value || "0", 10);
        const totalCount = parseInt((await kv.get(["usage", provider, "key", tail, "total"])).value || "0", 10);

        const cooldownEntry = await kv.get(["cooldown_until", tail]);
        const cooldownUntil = parseInt(cooldownEntry.value || "0", 10);
        const remainingSeconds = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

        const currentRPM = parseInt((await kv.get(["rpm", provider, tail, currentMinute])).value || "0", 10);
        const currentTPM = parseInt((await kv.get(["tpm", provider, tail, currentMinute])).value || "0", 10);

        keyStats.push({
          key: fullKey,
          masked: `...${tail}`,
          today: todayCount,
          total: totalCount,
          currentRPM: currentRPM,
          currentTPM: currentTPM,
          cooldownUntil: cooldownUntil,
          remainingSeconds: remainingSeconds,
        });
      }

      const modelStats = {};
      for (const m of Object.keys(MODEL_CATALOG)) {
        const todayCount = (await kv.get(["usage", provider, "model", m, "today", today])).value || "0";
        const totalCount = (await kv.get(["usage", provider, "model", m, "total"])).value || "0";
        const tokensToday = (await kv.get(["tokens", provider, "model", m, "today", today])).value || "0";
        modelStats[m] = {
          today: parseInt(todayCount, 10),
          total: parseInt(totalCount, 10),
          tokensToday: parseInt(tokensToday, 10),
        };
      }

      return { keys: keyStats, modelStats: modelStats };
    };

    return new Response(
      JSON.stringify({
        serverTime: now,
        date: today,
        catalog: MODEL_CATALOG,
        agnes: await getStats("agnes"),
        gemini: await getStats("gemini"),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  if (url.pathname === "/api/admin/keys" && request.method === "POST") {
    const body = await request.json();
    const provider = body.provider || "agnes";
    if (Array.isArray(body.keys)) {
      await kv.set(["config", "keys", provider], JSON.stringify(body.keys));
      return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
    }
  }

  return new Response(JSON.stringify({ error: "Not Found" }), { status: 404 });
}

function renderAdminHTML() {
  const html = `<!DOCTYPE html>
<html lang="zh-HK">
<head>
  <meta charset="UTF-8">
  <title>AI Studio Style Rate-Limit Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen p-6 font-sans antialiased">
  <div class="max-w-6xl mx-auto space-y-6">
    <!-- Header -->
    <div class="flex flex-col md:flex-row justify-between md:items-center bg-slate-900/90 p-6 rounded-2xl border border-slate-800 gap-4 shadow-xl backdrop-blur-sm">
      <div>
        <div class="flex items-center gap-2">
          <span class="text-2xl font-bold bg-gradient-to-r from-sky-400 via-indigo-400 to-purple-400 bg-clip-text text-transparent">AI Gateway & Quota Monitor</span>
          <span class="text-xs px-2.5 py-0.5 rounded-full bg-sky-950 text-sky-400 border border-sky-800">Active Countdown</span>
        </div>
        <p class="text-sm text-slate-400 mt-1">RPM · TPM · RPD Live Quotas & Automatic 429 Cooldown Ticker</p>
      </div>
      <div class="flex gap-2">
        <input id="pwdInput" type="password" placeholder="Admin Password" class="bg-slate-950 border border-slate-700 px-3.5 py-2 rounded-xl text-sm focus:outline-none focus:border-sky-500">
        <button onclick="fetchData()" class="bg-sky-600 hover:bg-sky-500 px-4 py-2 rounded-xl text-sm font-semibold transition shadow-md">登入 / 重新整理</button>
      </div>
    </div>

    <!-- Models List -->
    <div class="space-y-3">
      <div class="flex justify-between items-center px-1">
        <h2 class="text-lg font-bold text-slate-200 flex items-center gap-2">
          <span>📋</span> 可用模型清單與限額指標 (All Available Models)
        </h2>
        <span class="text-xs text-slate-500">Google AI Studio Free Tier Specification</span>
      </div>

      <div id="modelCatalogGrid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <div class="col-span-full py-8 text-center text-slate-500 bg-slate-900/50 rounded-2xl border border-slate-800">載入中...</div>
      </div>
    </div>

    <!-- Key Pool Table -->
    <div class="bg-slate-900/80 p-6 rounded-2xl border border-slate-800 shadow-xl space-y-4">
      <div class="flex flex-col md:flex-row justify-between md:items-center gap-4 border-b border-slate-800 pb-4">
        <div class="flex gap-2">
          <button id="tabAgnesBtn" onclick="switchTab('agnes')" class="px-4 py-2 rounded-xl text-sm font-semibold transition bg-sky-600 text-white">Agnes Key 池</button>
          <button id="tabGeminiBtn" onclick="switchTab('gemini')" class="px-4 py-2 rounded-xl text-sm font-semibold transition bg-slate-800 text-slate-400 hover:text-slate-200">Google Gemini Key 池</button>
        </div>
        <div class="flex gap-2">
          <button onclick="batchAddPrompt()" class="bg-indigo-600/80 hover:bg-indigo-600 px-3.5 py-1.5 rounded-xl text-xs font-semibold transition">+ 批量添加</button>
          <button onclick="addKeyPrompt()" class="bg-emerald-600 hover:bg-emerald-500 px-3.5 py-1.5 rounded-xl text-xs font-semibold transition">+ 新增 Key</button>
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="text-slate-400 text-xs uppercase tracking-wider border-b border-slate-800/80">
            <tr>
              <th class="py-3 px-2">Key 遮罩</th>
              <th class="py-3 px-2">即時狀態 (429 倒數)</th>
              <th class="py-3 px-2">即時 RPM</th>
              <th class="py-3 px-2">即時 TPM</th>
              <th class="py-3 px-2">今日 RPD</th>
              <th class="py-3 px-2">歷史累計</th>
              <th class="py-3 px-2 text-right">操作</th>
            </tr>
          </thead>
          <tbody id="keyTableBody" class="divide-y divide-slate-800/50">
            <tr><td colspan="7" class="py-6 text-center text-slate-500">請先登入以檢視數據</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    let activeProvider = 'agnes';
    let globalData = { catalog: {}, agnes: { keys: [], modelStats: {} }, gemini: { keys: [], modelStats: {} } };

    function switchTab(prov) {
      activeProvider = prov;
      document.getElementById('tabAgnesBtn').className = prov === 'agnes' ? 'px-4 py-2 rounded-xl text-sm font-semibold transition bg-sky-600 text-white shadow-md' : 'px-4 py-2 rounded-xl text-sm font-semibold transition bg-slate-800 text-slate-400 hover:text-slate-200';
      document.getElementById('tabGeminiBtn').className = prov === 'gemini' ? 'px-4 py-2 rounded-xl text-sm font-semibold transition bg-sky-600 text-white shadow-md' : 'px-4 py-2 rounded-xl text-sm font-semibold transition bg-slate-800 text-slate-400 hover:text-slate-200';
      renderView();
    }

    function getAuth() {
      const pwd = document.getElementById('pwdInput').value || localStorage.getItem('deno_proxy_pwd') || '';
      if(pwd) localStorage.setItem('deno_proxy_pwd', pwd);
      return 'Bearer ' + pwd;
    }

    window.onload = () => {
      const saved = localStorage.getItem('deno_proxy_pwd');
      if(saved) document.getElementById('pwdInput').value = saved;
      fetchData();

      // 1-second auto ticker for real-time countdown decrement
      setInterval(() => {
        const now = Date.now();
        let needsUpdate = false;
        ['agnes', 'gemini'].forEach(prov => {
          if (globalData[prov] && globalData[prov].keys) {
            globalData[prov].keys.forEach(k => {
              if (k.cooldownUntil && k.cooldownUntil > now) {
                k.remainingSeconds = Math.max(0, Math.ceil((k.cooldownUntil - now) / 1000));
                needsUpdate = true;
              } else if (k.remainingSeconds > 0) {
                k.remainingSeconds = 0;
                needsUpdate = true;
              }
            });
          }
        });
        if (needsUpdate) renderKeyPool();
      }, 1000);
    };

    async function fetchData() {
      try {
        const res = await fetch('/api/admin/data', { headers: { 'Authorization': getAuth() } });
        if(res.status === 401) return alert('密碼錯誤 (Invalid password)');
        globalData = await res.json();
        renderView();
      } catch(e) { console.error(e); }
    }

    function renderView() {
      renderCatalog();
      renderKeyPool();
    }

    function renderCatalog() {
      const catalog = globalData.catalog || {};
      const stats = (globalData[activeProvider] && globalData[activeProvider].modelStats) || {};
      const grid = document.getElementById('modelCatalogGrid');
      grid.innerHTML = '';

      for (const [id, meta] of Object.entries(catalog)) {
        const mUsage = stats[id] || { today: 0, total: 0, tokensToday: 0 };
        const isVirtual = meta.provider === 'virtual';

        const card = document.createElement('div');
        card.className = \`bg-slate-900/90 p-5 rounded-2xl border \${isVirtual ? 'border-indigo-500/50 bg-gradient-to-br from-slate-900 via-indigo-950/20 to-slate-900' : 'border-slate-800'} flex flex-col justify-between shadow-lg hover:border-slate-700 transition\`;

        card.innerHTML = \`
          <div>
            <div class="flex justify-between items-start mb-2">
              <div>
                <div class="font-bold text-slate-100 flex items-center gap-2">
                  <span>\${meta.name}</span>
                  \${isVirtual ? '<span class="text-[10px] bg-purple-900/80 text-purple-300 px-2 py-0.5 rounded-full border border-purple-700">自動備援</span>' : ''}
                </div>
                <div class="font-mono text-xs text-sky-400/90 mt-0.5">\${id}</div>
              </div>
              <span class="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">\${meta.provider}</span>
            </div>
            <p class="text-xs text-slate-400 mb-4 line-clamp-2">\${meta.desc}</p>
          </div>

          <div class="bg-slate-950/70 p-3 rounded-xl border border-slate-800/80 space-y-2 text-xs">
            <div class="flex justify-between items-center">
              <span class="text-slate-400">1. RPM (分請求上限)</span>
              <span class="font-mono text-amber-400 font-semibold">\${meta.rpmLimit} req/min</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-slate-400">2. TPM (分 Token 上限)</span>
              <span class="font-mono text-cyan-400 font-semibold">\${meta.tpmLimit} tokens</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-slate-400">3. RPD (日請求上限)</span>
              <span class="font-mono text-emerald-400 font-semibold">\${meta.rpdLimit} req/day</span>
            </div>
            <div class="pt-2 mt-2 border-t border-slate-800/60 flex justify-between text-[11px] text-slate-400">
              <span>今日累計: <b class="text-slate-200">\${mUsage.today} 次</b></span>
              <span>歷史總計: <b class="text-slate-200">\${mUsage.total} 次</b></span>
            </div>
          </div>
        \`;
        grid.appendChild(card);
      }
    }

    function renderKeyPool() {
      const pData = globalData[activeProvider] || { keys: [] };
      const tbody = document.getElementById('keyTableBody');

      if (!pData.keys || pData.keys.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="py-6 text-center text-slate-500">目前尚無配置 API Key，請點擊上方按鈕新增。</td></tr>';
        return;
      }

      tbody.innerHTML = pData.keys.map((k, idx) => {
        let statusBadge = '<span class="text-emerald-400 text-xs px-2.5 py-1 rounded-full bg-emerald-950/70 border border-emerald-800/80">正常 (Active)</span>';
        if (k.remainingSeconds && k.remainingSeconds > 0) {
          statusBadge = \`<span class="text-amber-400 text-xs px-2.5 py-1 rounded-full bg-amber-950/80 border border-amber-700/80 font-mono animate-pulse">429 冷卻中 (\${k.remainingSeconds}s)</span>\`;
        }

        return \`
          <tr class="hover:bg-slate-800/30 transition">
            <td class="py-3 px-2 font-mono text-slate-300">\${k.masked}</td>
            <td class="py-3 px-2">\${statusBadge}</td>
            <td class="py-3 px-2 font-mono text-amber-400 font-semibold">\${k.currentRPM || 0} <span class="text-slate-500 text-xs font-normal">RPM</span></td>
            <td class="py-3 px-2 font-mono text-cyan-400 font-semibold">\${(k.currentTPM || 0).toLocaleString()} <span class="text-slate-500 text-xs font-normal">TPM</span></td>
            <td class="py-3 px-2 font-mono text-emerald-400 font-semibold">\${k.today} <span class="text-slate-500 text-xs font-normal">RPD</span></td>
            <td class="py-3 px-2 font-mono text-slate-400">\${k.total}</td>
            <td class="py-3 px-2 text-right">
              <button onclick="deleteKey(\${idx})" class="text-rose-400 hover:text-rose-300 text-xs font-semibold px-2 py-1 rounded hover:bg-rose-950/40 transition">刪除</button>
            </td>
          </tr>
        \`;
      }).join('');
    }

    async function addKeyPrompt() {
      const key = prompt('輸入新的 API Key (' + activeProvider.toUpperCase() + '):');
      if (!key || !key.trim()) return;
      const current = (globalData[activeProvider].keys || []).map(k => k.key);
      current.push(key.trim());
      await saveKeys(current);
    }

    async function batchAddPrompt() {
      const text = prompt('批量貼上 API Key (用換行或逗號隔開):');
      if (!text || !text.trim()) return;
      const keys = text.split(/[\\n,]/).map(k => k.trim()).filter(Boolean);
      const current = (globalData[activeProvider].keys || []).map(k => k.key);
      current.push(...keys);
      await saveKeys(current);
    }

    async function deleteKey(idx) {
      if (!confirm('確定要刪除這組 Key 嗎？')) return;
      const current = globalData[activeProvider].keys.map(k => k.key);
      current.splice(idx, 1);
      await saveKeys(current);
    }

    async function saveKeys(keys) {
      await fetch('/api/admin/keys', {
        method: 'POST',
        headers: { 'Authorization': getAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: activeProvider, keys: keys })
      });
      fetchData();
    }
  </script>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
