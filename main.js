/**
 * Strict Multi-Provider Isolation Proxy for Deno Deploy
 * Providers: Google Gemini & Agnes AI (Strictly Isolated - No Cross Switching)
 * Features:
 *  - gemini models only rotate within Gemini Key pool
 *  - agnes-2.5-flash strictly rotates within Agnes Key pool (10 RPM / 250 RPD)
 *  - Explicit error message when all keys of a model reach the limit
 *  - Atomic KV tracking & Dual Admin Dashboard
 */

const kv = await Deno.openKv();
const GOOGLE_TARGET_HOST = "generativelanguage.googleapis.com";
const DEFAULT_AGNES_HOST = Deno.env.get("AGNES_HOST") || "api.agnes.ai";
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD") || "1234";

// 精確限制：agnes-2.5-flash
const AGNES_RPM_LIMIT = 10;
const AGNES_RPD_LIMIT = 250;

Deno.serve(async (request) => {
  const url = new URL(request.url);

  // 1. CORS 預檢
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

  // 2. 後台面板與管理 API
  if (url.pathname === "/admin" || url.pathname === "/") {
    return renderAdminHTML();
  }
  if (url.pathname.startsWith("/api/admin/")) {
    return handleAdminAPI(request, url);
  }

  // 3. /v1/models 模型清單
  if (url.pathname === "/v1/models" && request.method === "GET") {
    return new Response(
      JSON.stringify({
        object: "list",
        data: [
          { id: "agnes-2.5-flash", object: "model", created: 1717000000, owned_by: "agnes" },
          { id: "gemini-3.5-flash-lite", object: "model", created: 1717000000, owned_by: "google" },
          { id: "gemini-2.5-flash", object: "model", created: 1717000000, owned_by: "google" },
          { id: "gemini-2.5-pro", object: "model", created: 1717000000, owned_by: "google" },
        ],
      }),
      { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
    );
  }

  // 4. 解析請求 Body 與目標模型
  let bodyBuffer = null;
  let targetModel = "agnes-2.5-flash";

  if (request.method !== "GET" && request.method !== "HEAD") {
    bodyBuffer = await request.arrayBuffer();
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bodyBuffer));
      if (parsed.model) targetModel = parsed.model;
    } catch (_e) {}
  }

  // 嚴格判斷模型歸屬：Agnes 只能轉 Agnes，Gemini 只能轉 Gemini
  const isAgnes = targetModel.toLowerCase().startsWith("agnes");
  const provider = isAgnes ? "agnes" : "gemini";

  return await executeIsolatedRequest(request, url, bodyBuffer, targetModel, provider);
});

async function executeIsolatedRequest(request, url, bodyBuffer, targetModel, provider) {
  const today = new Date().toISOString().split("T")[0];
  const currentMinute = Math.floor(Date.now() / 60000);

  // 僅讀取該模型對應的專屬 Key 池
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
  // 在同一個 Provider 內部打散做負載均衡
  const shuffledPool = [...keyPool.filter((k) => k !== clientKey)].sort(() => Math.random() - 0.5);
  candidateKeys.push(...shuffledPool);

  if (candidateKeys.length === 0) {
    return new Response(
      JSON.stringify({
        error: {
          message: `No API keys configured for provider [${provider.toUpperCase()}]. Please add keys in /admin.`,
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // 篩選未達到冷卻與配額上限的可用 Key
  const usableKeys = [];
  for (const k of candidateKeys) {
    const tail = k.slice(-8);
    const cooldown = await kv.get(["cooldown", tail]);
    if (cooldown.value) continue;

    if (provider === "agnes") {
      // 檢查當日配額 (250 RPD)
      const rpdCount = parseInt((await kv.get(["usage", "agnes", "key", tail, "today", today])).value || "0", 10);
      if (rpdCount >= AGNES_RPD_LIMIT) continue;

      // 檢查當前分鐘頻率 (10 RPM)
      const rpmCount = parseInt((await kv.get(["rpm", "agnes", tail, currentMinute])).value || "0", 10);
      if (rpmCount >= AGNES_RPM_LIMIT) continue;
    }

    usableKeys.push(k);
  }

  // 若該模型的所有 Key 皆已達到上限，嚴格報錯，絕不跨供應商切換
  if (usableKeys.length === 0) {
    return new Response(
      JSON.stringify({
        error: {
          message: `All keys for model [${targetModel}] have reached the total limit. Please try again later or add more keys in the admin dashboard.`,
        },
      }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
  }

  // 確定請求目標主機與路徑
  const targetHost = provider === "agnes" ? DEFAULT_AGNES_HOST : GOOGLE_TARGET_HOST;
  let targetPath = url.pathname;
  if (provider === "gemini" && url.pathname.startsWith("/v1/")) {
    targetPath = "/v1beta/openai" + url.pathname;
  }

  let lastResponse = null;

  // 僅在同模型的 Key 池內部進行輪換
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

      // 上游返回 429 / 403 / 503 時，對該 Key 進行 60 秒冷卻並換同模型的下一個 Key
      if ([429, 403, 503].includes(response.status)) {
        await kv.set(["cooldown", tail], "1", { expireIn: 60000 });
        lastResponse = response;
        if (i < usableKeys.length - 1) continue;
      }

      const resHeaders = new Headers(response.headers);
      resHeaders.set("Access-Control-Allow-Origin", "*");
      resHeaders.set("X-Key-Used", `...${tail}`);
      resHeaders.set("X-Provider-Used", provider);
      resHeaders.delete("content-encoding");

      if (response.ok) {
        recordUsageAtomic(provider, currentKey, targetModel);
        if (provider === "agnes") {
          const rpmKey = ["rpm", "agnes", tail, currentMinute];
          const curRPM = parseInt((await kv.get(rpmKey)).value || "0", 10);
          await kv.set(rpmKey, (curRPM + 1).toString(), { expireIn: 120000 });
        }
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

  // 若輪換完畢仍全部失敗，明確返回模型限額錯誤
  return new Response(
    JSON.stringify({
      error: {
        message: `All keys for model [${targetModel}] have reached the total limit or failed.`,
      },
    }),
    { status: 429, headers: { "Content-Type": "application/json" } }
  );
}

async function recordUsageAtomic(provider, key, model) {
  const today = new Date().toISOString().split("T")[0];
  const keyTail = key.slice(-8);

  const kToday = ["usage", provider, "key", keyTail, "today", today];
  const kTotal = ["usage", provider, "key", keyTail, "total"];
  const mToday = ["usage", provider, "model", model, "today", today];
  const mTotal = ["usage", provider, "model", model, "total"];

  const [resKT, resKAll, resMT, resMAll] = await kv.getMany([kToday, kTotal, mToday, mTotal]);

  await kv.atomic()
    .set(kToday, (parseInt(resKT.value || "0", 10) + 1).toString())
    .set(kTotal, (parseInt(resKAll.value || "0", 10) + 1).toString())
    .set(mToday, (parseInt(resMT.value || "0", 10) + 1).toString())
    .set(mTotal, (parseInt(resMAll.value || "0", 10) + 1).toString())
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
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  if (url.pathname === "/api/admin/data" && request.method === "GET") {
    const today = new Date().toISOString().split("T")[0];
    const currentMinute = Math.floor(Date.now() / 60000);

    const getStats = async (provider) => {
      const rawKeys = (await kv.get(["config", "keys", provider])).value || "[]";
      const keyPool = JSON.parse(rawKeys);
      const modelsList = JSON.parse((await kv.get(["index", provider, "models"])).value || "[]");

      const keyStats = [];
      for (const fullKey of keyPool) {
        const tail = fullKey.slice(-8);
        const todayCount = parseInt((await kv.get(["usage", provider, "key", tail, "today", today])).value || "0", 10);
        const totalCount = parseInt((await kv.get(["usage", provider, "key", tail, "total"])).value || "0", 10);
        const cooldown = (await kv.get(["cooldown", tail])).value ? true : false;
        const currentRPM = parseInt((await kv.get(["rpm", provider, tail, currentMinute])).value || "0", 10);
        const isRpdLimit = provider === "agnes" && todayCount >= AGNES_RPD_LIMIT;
        const isRpmLimit = provider === "agnes" && currentRPM >= AGNES_RPM_LIMIT;

        keyStats.push({
          key: fullKey,
          masked: `...${tail}`,
          today: todayCount,
          total: totalCount,
          currentRPM: currentRPM,
          inCooldown: cooldown,
          limitReached: isRpdLimit || isRpmLimit,
        });
      }

      const modelStats = [];
      for (const m of modelsList) {
        const todayCount = (await kv.get(["usage", provider, "model", m, "today", today])).value || "0";
        const totalCount = (await kv.get(["usage", provider, "model", m, "total"])).value || "0";
        modelStats.push({ model: m, today: parseInt(todayCount, 10), total: parseInt(totalCount, 10) });
      }

      return { keys: keyStats, models: modelStats, rpdLimit: AGNES_RPD_LIMIT, rpmLimit: AGNES_RPM_LIMIT };
    };

    return new Response(
      JSON.stringify({ date: today, agnes: await getStats("agnes"), gemini: await getStats("gemini") }),
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
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Isolated AI Edge Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen p-6 font-sans">
  <div class="max-w-5xl mx-auto space-y-6">
    <div class="flex flex-col md:flex-row justify-between md:items-center bg-slate-800 p-6 rounded-2xl border border-slate-700 gap-4 shadow-lg">
      <div>
        <h1 class="text-2xl font-bold text-sky-400">Strict Isolated AI Proxy</h1>
        <p class="text-sm text-slate-400 mt-1">Strict Model Isolation · Separate Key Pools · Exact Quota Enforced</p>
      </div>
      <div class="flex gap-2">
        <input id="pwdInput" type="password" placeholder="Admin Password" class="bg-slate-950 border border-slate-700 px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-sky-500">
        <button onclick="fetchData()" class="bg-sky-600 hover:bg-sky-500 px-4 py-2 rounded-lg text-sm font-semibold transition">Login / Refresh</button>
      </div>
    </div>

    <!-- Isolated Tabs -->
    <div class="flex border-b border-slate-700 gap-4 text-sm font-medium">
      <button id="tabAgnesBtn" onclick="switchTab('agnes')" class="pb-3 border-b-2 border-sky-400 text-sky-400">Agnes (agnes-2.5-flash Only)</button>
      <button id="tabGeminiBtn" onclick="switchTab('gemini')" class="pb-3 border-b-2 border-transparent text-slate-400 hover:text-slate-200">Google Gemini (Gemini Models Only)</button>
    </div>

    <!-- Usage Metrics -->
    <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-md">
      <h2 class="text-lg font-semibold text-slate-200 mb-4">📊 <span id="currentProviderLabel">Agnes</span> Model Metrics</h2>
      <div id="modelList" class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="text-slate-500 text-sm">Please login...</div>
      </div>
    </div>

    <!-- Key Pool Table -->
    <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-md">
      <div class="flex justify-between items-center mb-4">
        <div>
          <h2 class="text-lg font-semibold text-slate-200">🔑 <span id="currentKeyPoolLabel">Agnes</span> Key Pool</h2>
          <div id="limitInfoText" class="text-xs text-sky-400 mt-1"></div>
        </div>
        <div class="flex gap-2">
          <button onclick="batchAddPrompt()" class="bg-indigo-600 hover:bg-indigo-500 px-3 py-1.5 rounded-lg text-sm font-semibold transition">Batch Add</button>
          <button onclick="addKeyPrompt()" class="bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 rounded-lg text-sm font-semibold transition">+ Add Key</button>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="text-slate-400 border-b border-slate-700">
            <tr>
              <th class="py-2">Key Mask</th>
              <th class="py-2">Status</th>
              <th class="py-2">RPM</th>
              <th class="py-2">Today (RPD)</th>
              <th class="py-2">Total</th>
              <th class="py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody id="keyTableBody" class="divide-y divide-slate-700/50">
            <tr><td colspan="6" class="py-4 text-center text-slate-500">No keys found</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    let activeProvider = 'agnes';
    let globalData = { agnes: { keys: [], models: [] }, gemini: { keys: [], models: [] } };

    function switchTab(prov) {
      activeProvider = prov;
      document.getElementById('tabAgnesBtn').className = prov === 'agnes' ? 'pb-3 border-b-2 border-sky-400 text-sky-400' : 'pb-3 border-b-2 border-transparent text-slate-400 hover:text-slate-200';
      document.getElementById('tabGeminiBtn').className = prov === 'gemini' ? 'pb-3 border-b-2 border-sky-400 text-sky-400' : 'pb-3 border-b-2 border-transparent text-slate-400 hover:text-slate-200';
      document.getElementById('currentProviderLabel').innerText = prov === 'agnes' ? 'Agnes' : 'Gemini';
      document.getElementById('currentKeyPoolLabel').innerText = prov === 'agnes' ? 'Agnes' : 'Gemini';
      renderCurrentProvider();
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
    };

    async function fetchData() {
      try {
        const res = await fetch('/api/admin/data', { headers: { 'Authorization': getAuth() } });
        if(res.status === 401) return alert('Invalid password');
        globalData = await res.json();
        renderCurrentProvider();
      } catch(e) { console.error(e); }
    }

    function renderCurrentProvider() {
      const pData = globalData[activeProvider] || { keys: [], models: [] };
      const limitText = document.getElementById('limitInfoText');
      if(activeProvider === 'agnes') {
        limitText.innerText = 'Strict: 10 RPM / 250 RPD per key. Rotates only within Agnes.';
      } else {
        limitText.innerText = 'Standard limits. Rotates only within Gemini.';
      }

      const mBox = document.getElementById('modelList');
      if(!pData.models || pData.models.length === 0) {
        mBox.innerHTML = '<div class="text-slate-500 text-sm">No usage yet.</div>';
      } else {
        mBox.innerHTML = pData.models.map(m => \`
          <div class="bg-slate-900/60 p-4 rounded-xl border border-slate-700/50">
            <div class="text-sm font-semibold text-slate-300 truncate">\${m.model}</div>
            <div class="flex justify-between mt-3 text-xs">
              <span class="text-slate-400">Today: <b class="text-emerald-400">\${m.today}</b></span>
              <span class="text-slate-400">Total: <b class="text-sky-400">\${m.total}</b></span>
            </div>
          </div>\`).join('');
      }

      const tbody = document.getElementById('keyTableBody');
      if(!pData.keys || pData.keys.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="py-4 text-center text-slate-500">No keys configured for ' + activeProvider + '.</td></tr>';
      } else {
        tbody.innerHTML = pData.keys.map((k, idx) => {
          let statusBadge = '<span class="text-emerald-400 text-xs px-2 py-0.5 rounded bg-emerald-950/60 border border-emerald-800">Active</span>';
          if(k.inCooldown) statusBadge = '<span class="text-amber-400 text-xs px-2 py-0.5 rounded bg-amber-950/60 border border-amber-800">429 Cooldown (60s)</span>';
          else if(k.limitReached) statusBadge = '<span class="text-rose-400 text-xs px-2 py-0.5 rounded bg-rose-950/60 border border-rose-800">Limit Reached</span>';

          return \`
            <tr class="hover:bg-slate-700/30 transition">
              <td class="py-3 font-mono">\${k.masked}</td>
              <td class="py-3">\${statusBadge}</td>
              <td class="py-3 text-slate-300 font-mono">\${k.currentRPM || 0} / 10</td>
              <td class="py-3 text-emerald-400 font-semibold">\${k.today} / 250</td>
              <td class="py-3 text-sky-400 font-semibold">\${k.total}</td>
              <td class="py-3 text-right">
                <button onclick="deleteKey(\${idx})" class="text-rose-400 hover:text-rose-300 text-xs">Delete</button>
              </td>
            </tr>\`;
        }).join('');
      }
    }

    async function addKeyPrompt() {
      const key = prompt('Enter API Key for ' + activeProvider + ':');
      if(!key || !key.trim()) return;
      const current = (globalData[activeProvider].keys || []).map(k => k.key);
      current.push(key.trim());
      await saveKeys(current);
    }

    async function batchAddPrompt() {
      const text = prompt('Enter multiple keys for ' + activeProvider + ' (comma/newline separated):');
      if(!text || !text.trim()) return;
      const keys = text.split(/[\\n,]/).map(k => k.trim()).filter(Boolean);
      const current = (globalData[activeProvider].keys || []).map(k => k.key);
      current.push(...keys);
      await saveKeys(current);
    }

    async function deleteKey(idx) {
      if(!confirm('Delete this key?')) return;
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
