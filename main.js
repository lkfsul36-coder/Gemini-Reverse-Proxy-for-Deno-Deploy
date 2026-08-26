/**
 * Ultra-Stable Multi-Provider AI Proxy with Auto-Expiring Cooldown
 * Features:
 *  - Auto-clearing Cooldown (Timestamp-based 60s auto-unlock)
 *  - Per-Model & Per-Key Enable/Disable Toggle
 *  - mixed-lite auto-skips disabled models and disabled keys
 *  - Deno KV Persisted Config
 */

const kv = await Deno.openKv();
const GOOGLE_TARGET_HOST = "generativelanguage.googleapis.com";
const AGNES_TARGET_HOST = "apihub.agnes-ai.com";
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD") || "1234";

const AGNES_RPM_LIMIT = 10;
const AGNES_RPD_LIMIT = 250;
const COOLDOWN_DURATION_MS = 60000; // 60秒自動解除冷卻

const MODEL_CATALOG = {
  "mixed-lite": {
    name: "Mixed-Lite (Virtual Auto-Failover)",
    provider: "virtual",
    rpmLimit: "Adaptive (10-30)",
    tpmLimit: "250K - 1M",
    rpdLimit: "Aggregated (250+)",
    desc: "自動跳過已禁用或冷卻中的模型，於啟用模型中階梯降級備援",
  },
  "agnes-2.5-flash": {
    name: "Agnes 2.5 Flash",
    provider: "agnes",
    rpmLimit: 10,
    tpmLimit: "250,000",
    rpdLimit: 250,
    desc: "第 1 順位：Agnes 旗艦多模態模型 (10 RPM / 250 RPD)",
  },
  "gemini-3.5-flash-lite": {
    name: "Gemini 3.5 Flash-Lite",
    provider: "gemini",
    rpmLimit: 30,
    tpmLimit: "1,000,000",
    rpdLimit: 1500,
    desc: "第 2 順位：次世代超輕量高併發模型",
  },
  "gemini-3.1-flash-lite": {
    name: "Gemini 3.1 Flash-Lite",
    provider: "gemini",
    rpmLimit: 30,
    tpmLimit: "1,000,000",
    rpdLimit: 1500,
    desc: "第 3 順位：高穩定輕量推理模型",
  },
  "gemini-3.7-flash": {
    name: "Gemini 3.7 Flash",
    provider: "gemini",
    rpmLimit: 15,
    tpmLimit: "1,000,000",
    rpdLimit: 1500,
    desc: "第 4 順位：終極高智商 Flash 旗艦模型",
  },
};

const MIXED_LITE_CHAIN = [
  { provider: "agnes", model: "agnes-2.5-flash" },
  { provider: "gemini", model: "gemini-3.5-flash-lite" },
  { provider: "gemini", model: "gemini-3.1-flash-lite" },
  { provider: "gemini", model: "gemini-3.7-flash" },
];

async function isModelDisabled(modelId) {
  const res = await kv.get(["config", "disabled_models"]);
  const list = res.value ? JSON.parse(res.value) : [];
  return list.includes(modelId);
}

// 檢查並自動清理冷卻狀態
async function checkAndCleanCooldown(keyTail) {
  const cooldownRes = await kv.get(["cooldown", keyTail]);
  if (!cooldownRes.value) return false;

  const expireTime = parseInt(cooldownRes.value, 10);
  const now = Date.now();

  if (now >= expireTime) {
    // 時間已過，自動刪除冷卻
    await kv.delete(["cooldown", keyTail]);
    return false;
  }
  return true; // 仍在冷卻中
}

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

  // 2. 後台面板與 API
  if (url.pathname === "/admin" || url.pathname === "/") {
    return renderAdminHTML();
  }
  if (url.pathname.startsWith("/api/admin/")) {
    return handleAdminAPI(request, url);
  }

  // 3. /v1/models 列表查詢
  if (url.pathname === "/v1/models" && request.method === "GET") {
    return handleModelsList();
  }

  // 4. 解析請求 Body
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

  if (requestedModel !== "mixed-lite" && await isModelDisabled(requestedModel)) {
    return new Response(
      JSON.stringify({ error: { message: `Model [${requestedModel}] has been disabled by administrator.` } }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  // 5. 虛擬模型 mixed-lite 階梯調度
  if (requestedModel === "mixed-lite") {
    return await executeMixedLiteChain(request, url, requestJson);
  }

  // 6. 原生獨立模型調度
  const isAgnes = requestedModel.toLowerCase().startsWith("agnes");
  const provider = isAgnes ? "agnes" : "gemini";
  return await executeSingleModel(request, url, bodyBuffer, requestedModel, provider);
});

async function executeMixedLiteChain(request, url, requestJson) {
  let lastResponse = null;
  const resDisabled = await kv.get(["config", "disabled_models"]);
  const disabledList = resDisabled.value ? JSON.parse(resDisabled.value) : [];

  for (let i = 0; i < MIXED_LITE_CHAIN.length; i++) {
    const step = MIXED_LITE_CHAIN[i];

    if (disabledList.includes(step.model)) {
      continue;
    }

    let activeBuffer = null;
    if (requestJson) {
      const cloned = JSON.parse(JSON.stringify(requestJson));
      cloned.model = step.model;
      activeBuffer = new TextEncoder().encode(JSON.stringify(cloned));
    }

    const res = await attemptForward(request, url, activeBuffer, step.model, step.provider, true);
    if (res && res.ok) {
      const resHeaders = new Headers(res.headers);
      resHeaders.set("X-Virtual-Model", "mixed-lite");
      resHeaders.set("X-Resolved-Model", step.model);
      resHeaders.set("X-Provider-Used", step.provider);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: resHeaders });
    }

    await appendLog({
      type: "failover",
      message: `[mixed-lite] 模型 [${step.model}] 異常 (${res ? res.status : "冷卻中/超時"}). 自動嘗試下一順位可用模型.`,
    });

    if (res) lastResponse = res;
  }

  if (lastResponse) return lastResponse;

  await appendLog({
    type: "exhausted",
    message: `[mixed-lite] 所有已啟用的備援模型皆已耗盡或無法連線！`,
  });

  return new Response(
    JSON.stringify({
      error: {
        message: "All active fallback tiers for [mixed-lite] have reached limit or are disabled. Please check /admin.",
      },
    }),
    { status: 429, headers: { "Content-Type": "application/json" } }
  );
}

async function executeSingleModel(request, url, bodyBuffer, targetModel, provider) {
  const res = await attemptForward(request, url, bodyBuffer, targetModel, provider, false);
  if (res) return res;

  await appendLog({
    type: "exhausted",
    message: `模型 [${targetModel}] 達到限額或所有 Key 冷卻中。`,
  });

  return new Response(
    JSON.stringify({
      error: {
        message: `All keys for model [${targetModel}] have reached the total limit or are in cooldown.`,
      },
    }),
    { status: 429, headers: { "Content-Type": "application/json" } }
  );
}

async function attemptForward(request, url, bodyBuffer, targetModel, provider, isFallbackMode) {
  const today = new Date().toISOString().split("T")[0];
  const currentMinute = Math.floor(Date.now() / 60000);

  const keysEntry = await kv.get(["config", "keys", provider]);
  const keyPool = keysEntry.value ? JSON.parse(keysEntry.value) : [];

  const disabledKeysEntry = await kv.get(["config", "disabled_keys", provider]);
  const disabledKeys = disabledKeysEntry.value ? JSON.parse(disabledKeysEntry.value) : [];

  if (keyPool.length === 0) return null;

  const candidateKeys = [...keyPool].sort(() => Math.random() - 0.5);
  const usableKeys = [];

  for (const k of candidateKeys) {
    if (disabledKeys.includes(k)) continue;

    const tail = k.slice(-8);
    const isInCooldown = await checkAndCleanCooldown(tail);
    if (isInCooldown) continue;

    if (provider === "agnes") {
      const rpdCount = parseInt((await kv.get(["usage", "agnes", "key", tail, "today", today])).value || "0", 10);
      if (rpdCount >= AGNES_RPD_LIMIT) continue;

      const rpmCount = parseInt((await kv.get(["rpm", "agnes", tail, currentMinute])).value || "0", 10);
      if (rpmCount >= AGNES_RPM_LIMIT) continue;
    }
    usableKeys.push(k);
  }

  if (usableKeys.length === 0) return null;

  let targetHost = AGNES_TARGET_HOST;
  let targetPath = url.pathname;

  if (provider === "agnes") {
    targetHost = AGNES_TARGET_HOST;
    targetPath = "/v1/chat/completions";
  } else if (provider === "gemini") {
    targetHost = GOOGLE_TARGET_HOST;
    targetPath = "/v1beta/openai/chat/completions";
  }

  for (let i = 0; i < usableKeys.length; i++) {
    const currentKey = usableKeys[i];
    const tail = currentKey.slice(-8);
    const targetUrl = new URL(`https://${targetHost}${targetPath}${url.search}`);
    if (provider !== "agnes") targetUrl.searchParams.set("key", currentKey);

    const cleanHeaders = new Headers();
    cleanHeaders.set("Content-Type", "application/json");
    cleanHeaders.set("Authorization", `Bearer ${currentKey}`);
    if (provider !== "agnes") cleanHeaders.set("x-goog-api-key", currentKey);
    cleanHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36");
    cleanHeaders.set("Accept", "application/json, text/plain, */*");
    cleanHeaders.set("Accept-Language", "en-US,en;q=0.9");
    cleanHeaders.set("Origin", "https://platform.agnes-ai.com");
    cleanHeaders.set("Referer", "https://platform.agnes-ai.com/");

    const timeoutMs = provider === "agnes" ? 6000 : 15000;

    const targetReq = new Request(targetUrl.toString(), {
      method: "POST",
      headers: cleanHeaders,
      body: bodyBuffer ? bodyBuffer.slice(0) : null,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });

    try {
      const response = await fetch(targetReq);

      if ([400, 401, 403, 404, 429, 500, 502, 503, 504].includes(response.status)) {
        await recordErrorAtomic(provider, currentKey);
        // 設定精確 60 秒冷卻戳記
        await kv.set(["cooldown", tail], (Date.now() + COOLDOWN_DURATION_MS).toString());

        await appendLog({
          type: "error",
          message: `Key [...${tail}] 在 [${targetModel}] 觸發 HTTP ${response.status}。進入 60 秒自動冷卻。`,
        });

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
      } else {
        await recordErrorAtomic(provider, currentKey);
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: resHeaders,
      });
    } catch (err) {
      await recordErrorAtomic(provider, currentKey);
      // 網路或超時錯誤，自動冷卻 60 秒
      await kv.set(["cooldown", tail], (Date.now() + COOLDOWN_DURATION_MS).toString());

      await appendLog({
        type: "error",
        message: `連線至 ${targetHost} 失敗/超時 (...${tail} - ${targetModel}): ${err.message}`,
      });
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
}

async function recordErrorAtomic(provider, key) {
  const keyTail = key.slice(-8);
  const errKey = ["errors", provider, keyTail];
  const res = await kv.get(errKey);
  const count = parseInt(res.value || "0", 10) + 1;
  await kv.set(errKey, count.toString());
}

async function appendLog(event) {
  const logEntry = {
    time: new Date().toLocaleTimeString(),
    type: event.type,
    message: event.message,
  };
  const res = await kv.get(["system", "logs"]);
  let logs = res.value ? JSON.parse(res.value) : [];
  logs.unshift(logEntry);
  if (logs.length > 50) logs = logs.slice(0, 50);
  await kv.set(["system", "logs"], JSON.stringify(logs));
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
    const today = new Date().toISOString().split("T")[0];
    const currentMinute = Math.floor(Date.now() / 60000);

    const disabledModelsRes = await kv.get(["config", "disabled_models"]);
    const disabledModels = disabledModelsRes.value ? JSON.parse(disabledModelsRes.value) : [];

    const getStats = async (provider) => {
      const rawKeys = (await kv.get(["config", "keys", provider])).value || "[]";
      const keyPool = JSON.parse(rawKeys);

      const rawDisabledKeys = (await kv.get(["config", "disabled_keys", provider])).value || "[]";
      const disabledKeys = JSON.parse(rawDisabledKeys);

      const keyStats = [];
      for (const fullKey of keyPool) {
        const tail = fullKey.slice(-8);
        const todayCount = parseInt((await kv.get(["usage", provider, "key", tail, "today", today])).value || "0", 10);
        const totalCount = parseInt((await kv.get(["usage", provider, "key", tail, "total"])).value || "0", 10);
        const errorCount = parseInt((await kv.get(["errors", provider, tail])).value || "0", 10);
        
        // 即時檢查並自動清理過期冷卻
        const cooldown = await checkAndCleanCooldown(tail);
        
        const currentRPM = parseInt((await kv.get(["rpm", provider, tail, currentMinute])).value || "0", 10);
        const currentTPM = parseInt((await kv.get(["tpm", provider, tail, currentMinute])).value || "0", 10);

        keyStats.push({
          key: fullKey,
          masked: `...${tail}`,
          today: todayCount,
          total: totalCount,
          errors: errorCount,
          currentRPM: currentRPM,
          currentTPM: currentTPM,
          inCooldown: cooldown,
          disabled: disabledKeys.includes(fullKey),
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

    const logsRes = await kv.get(["system", "logs"]);
    const logs = logsRes.value ? JSON.parse(logsRes.value) : [];

    return new Response(
      JSON.stringify({
        date: today,
        catalog: MODEL_CATALOG,
        disabledModels: disabledModels,
        agnes: await getStats("agnes"),
        gemini: await getStats("gemini"),
        logs: logs,
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

  if (url.pathname === "/api/admin/toggle-model" && request.method === "POST") {
    const body = await request.json();
    const modelId = body.model;
    const res = await kv.get(["config", "disabled_models"]);
    let list = res.value ? JSON.parse(res.value) : [];
    if (list.includes(modelId)) {
      list = list.filter(m => m !== modelId);
    } else {
      list.push(modelId);
    }
    await kv.set(["config", "disabled_models"], JSON.stringify(list));
    return new Response(JSON.stringify({ success: true, disabledModels: list }), { headers: { "Content-Type": "application/json" } });
  }

  if (url.pathname === "/api/admin/toggle-key" && request.method === "POST") {
    const body = await request.json();
    const { provider, key } = body;
    const res = await kv.get(["config", "disabled_keys", provider]);
    let list = res.value ? JSON.parse(res.value) : [];
    if (list.includes(key)) {
      list = list.filter(k => k !== key);
    } else {
      list.push(key);
    }
    await kv.set(["config", "disabled_keys", provider], JSON.stringify(list));
    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
  }

  if (url.pathname === "/api/admin/reset-cooldown" && request.method === "POST") {
    for await (const entry of kv.list({ prefix: ["cooldown"] })) {
      await kv.delete(entry.key);
    }
    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
  }

  if (url.pathname === "/api/admin/clear-logs" && request.method === "POST") {
    await kv.set(["system", "logs"], JSON.stringify([]));
    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({ error: "Not Found" }), { status: 404 });
}

function renderAdminHTML() {
  const html = `<!DOCTYPE html>
<html lang="zh-HK">
<head>
  <meta charset="UTF-8">
  <title>AI Studio Style Rate-Limit & Event Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen p-6 font-sans antialiased">
  <div class="max-w-6xl mx-auto space-y-6">
    <div class="flex flex-col md:flex-row justify-between md:items-center bg-slate-900/90 p-6 rounded-2xl border border-slate-800 gap-4 shadow-xl backdrop-blur-sm">
      <div>
        <div class="flex items-center gap-2">
          <span class="text-2xl font-bold bg-gradient-to-r from-sky-400 via-indigo-400 to-purple-400 bg-clip-text text-transparent">AI Gateway & Quota Monitor</span>
          <span class="text-xs px-2.5 py-0.5 rounded-full bg-sky-950 text-sky-400 border border-sky-800">Auto-Expiry Cooldown</span>
        </div>
        <p class="text-sm text-slate-400 mt-1">冷卻時間 (60秒) 到期自動解除 · 支援模型與 Key 開關控制</p>
      </div>
      <div class="flex gap-2">
        <input id="pwdInput" type="password" placeholder="Admin Password" class="bg-slate-950 border border-slate-700 px-3.5 py-2 rounded-xl text-sm focus:outline-none focus:border-sky-500">
        <button onclick="fetchData()" class="bg-sky-600 hover:bg-sky-500 px-4 py-2 rounded-xl text-sm font-semibold transition shadow-md">登入 / 重新整理</button>
      </div>
    </div>

    <!-- Section 1: Model Catalog with Toggle -->
    <div class="space-y-3">
      <div class="flex justify-between items-center px-1">
        <h2 class="text-lg font-bold text-slate-200 flex items-center gap-2">
          <span>📋</span> 可用模型清單與限額指標
        </h2>
        <span class="text-xs text-slate-500">點擊按鈕可隨時停用特定模型</span>
      </div>
      <div id="modelCatalogGrid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <div class="col-span-full py-8 text-center text-slate-500 bg-slate-900/50 rounded-2xl border border-slate-800">載入中...</div>
      </div>
    </div>

    <!-- Section 2: Key Pool Table -->
    <div class="bg-slate-900/80 p-6 rounded-2xl border border-slate-800 shadow-xl space-y-4">
      <div class="flex flex-col md:flex-row justify-between md:items-center gap-4 border-b border-slate-800 pb-4">
        <div class="flex gap-2">
          <button id="tabAgnesBtn" onclick="switchTab('agnes')" class="px-4 py-2 rounded-xl text-sm font-semibold transition bg-sky-600 text-white">Agnes Key 池</button>
          <button id="tabGeminiBtn" onclick="switchTab('gemini')" class="px-4 py-2 rounded-xl text-sm font-semibold transition bg-slate-800 text-slate-400 hover:text-slate-200">Google Gemini Key 池</button>
        </div>
        <div class="flex gap-2 items-center">
          <button onclick="resetCooldown()" class="bg-amber-600/80 hover:bg-amber-600 px-3.5 py-1.5 rounded-xl text-xs font-semibold transition">⚡ 立即清空所有冷卻</button>
          <button onclick="batchAddPrompt()" class="bg-indigo-600/80 hover:bg-indigo-600 px-3.5 py-1.5 rounded-xl text-xs font-semibold transition">+ 批量添加</button>
          <button onclick="addKeyPrompt()" class="bg-emerald-600 hover:bg-emerald-500 px-3.5 py-1.5 rounded-xl text-xs font-semibold transition">+ 新增 Key</button>
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="text-slate-400 text-xs uppercase tracking-wider border-b border-slate-800/80">
            <tr>
              <th class="py-3 px-2">Key 遮罩</th>
              <th class="py-3 px-2">即時狀態 (60s自動解除)</th>
              <th class="py-3 px-2">即時 RPM</th>
              <th class="py-3 px-2">即時 TPM</th>
              <th class="py-3 px-2">今日 RPD</th>
              <th class="py-3 px-2">累計錯誤</th>
              <th class="py-3 px-2">歷史成功總計</th>
              <th class="py-3 px-2 text-right">操作</th>
            </tr>
          </thead>
          <tbody id="keyTableBody" class="divide-y divide-slate-800/50">
            <tr><td colspan="8" class="py-6 text-center text-slate-500">請先登入以檢視數據</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Section 3: Live Failover & Error Logs -->
    <div class="bg-slate-900/80 p-6 rounded-2xl border border-slate-800 shadow-xl space-y-4">
      <div class="flex justify-between items-center border-b border-slate-800 pb-3">
        <div class="flex items-center gap-2">
          <span class="text-base font-bold text-slate-200">📜 系統故障轉移與限流日誌 (Live Failover & Error Logs)</span>
          <span class="text-[10px] bg-slate-800 text-slate-400 px-2 py-0.5 rounded">最近 50 筆</span>
        </div>
        <button onclick="clearLogs()" class="text-xs text-slate-400 hover:text-slate-200 hover:underline">清空日誌</button>
      </div>
      <div id="logsContainer" class="bg-slate-950 p-4 rounded-xl font-mono text-xs max-h-60 overflow-y-auto space-y-2 border border-slate-800/80">
        <div class="text-slate-600">尚無故障或降級轉移記錄。</div>
      </div>
    </div>
  </div>

  <script>
    let activeProvider = 'agnes';
    let globalData = { catalog: {}, disabledModels: [], agnes: { keys: [], modelStats: {} }, gemini: { keys: [], modelStats: {} }, logs: [] };

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
      renderLogs();
    }

    function renderCatalog() {
      const catalog = globalData.catalog || {};
      const disabledModels = globalData.disabledModels || [];
      const stats = (globalData[activeProvider] && globalData[activeProvider].modelStats) || {};
      const grid = document.getElementById('modelCatalogGrid');
      grid.innerHTML = '';

      for (const [id, meta] of Object.entries(catalog)) {
        const mUsage = stats[id] || { today: 0, total: 0, tokensToday: 0 };
        const isVirtual = meta.provider === 'virtual';
        const isDisabled = disabledModels.includes(id);

        const card = document.createElement('div');
        card.className = \`bg-slate-900/90 p-5 rounded-2xl border \${isDisabled ? 'opacity-50 border-rose-900/50 bg-slate-950' : (isVirtual ? 'border-indigo-500/50 bg-gradient-to-br from-slate-900 via-indigo-950/20 to-slate-900' : 'border-slate-800')} flex flex-col justify-between shadow-lg hover:border-slate-700 transition\`;

        let toggleBtnHtml = '';
        if (!isVirtual) {
          toggleBtnHtml = \`
            <button onclick="toggleModel('\${id}')" class="text-xs px-2 py-0.5 rounded-full font-semibold transition \${isDisabled ? 'bg-rose-950 text-rose-400 border border-rose-800 hover:bg-rose-900' : 'bg-emerald-950 text-emerald-400 border border-emerald-800 hover:bg-emerald-900'}">
              \${isDisabled ? '❌ 已禁用' : '🟢 啟用中'}
            </button>
          \`;
        }

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
              <div class="flex items-center gap-1.5">
                \${toggleBtnHtml}
                <span class="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">\${meta.provider}</span>
              </div>
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
        tbody.innerHTML = '<tr><td colspan="8" class="py-6 text-center text-slate-500">目前尚無配置 API Key，請點擊上方按鈕新增。</td></tr>';
        return;
      }

      tbody.innerHTML = pData.keys.map((k, idx) => {
        let statusBadge = '<span class="text-emerald-400 text-xs px-2.5 py-1 rounded-full bg-emerald-950/70 border border-emerald-800/80">正常 (Active)</span>';
        if (k.disabled) {
          statusBadge = '<span class="text-slate-400 text-xs px-2.5 py-1 rounded-full bg-slate-800 border border-slate-700">已停用 (Disabled)</span>';
        } else if (k.inCooldown) {
          statusBadge = '<span class="text-amber-400 text-xs px-2.5 py-1 rounded-full bg-amber-950/70 border border-amber-800/80">冷卻中 (60s自動解除)</span>';
        }

        const errorBadge = (k.errors > 0) 
          ? \`<span class="text-rose-400 font-mono font-bold bg-rose-950/60 border border-rose-800/80 px-2 py-0.5 rounded-lg">\${k.errors}</span>\`
          : \`<span class="text-slate-500 font-mono">0</span>\`;

        return \`
          <tr class="hover:bg-slate-800/30 transition \${k.disabled ? 'opacity-40' : ''}">
            <td class="py-3 px-2 font-mono text-slate-300">\${k.masked}</td>
            <td class="py-3 px-2">\${statusBadge}</td>
            <td class="py-3 px-2 font-mono text-amber-400 font-semibold">\${k.currentRPM || 0} <span class="text-slate-500 text-xs font-normal">RPM</span></td>
            <td class="py-3 px-2 font-mono text-cyan-400 font-semibold">\${(k.currentTPM || 0).toLocaleString()} <span class="text-slate-500 text-xs font-normal">TPM</span></td>
            <td class="py-3 px-2 font-mono text-emerald-400 font-semibold">\${k.today} <span class="text-slate-500 text-xs font-normal">RPD</span></td>
            <td class="py-3 px-2">\${errorBadge}</td>
            <td class="py-3 px-2 font-mono text-slate-400">\${k.total}</td>
            <td class="py-3 px-2 text-right space-x-2">
              <button onclick="toggleKey('\${k.key}')" class="text-xs font-semibold px-2 py-1 rounded transition \${k.disabled ? 'text-emerald-400 hover:bg-emerald-950/40' : 'text-amber-400 hover:bg-amber-950/40'}">
                \${k.disabled ? '啟用' : '禁用'}
              </button>
              <button onclick="deleteKey(\${idx})" class="text-rose-400 hover:text-rose-300 text-xs font-semibold px-2 py-1 rounded hover:bg-rose-950/40 transition">刪除</button>
            </td>
          </tr>
        \`;
      }).join('');
    }

    function renderLogs() {
      const logs = globalData.logs || [];
      const container = document.getElementById('logsContainer');

      if (logs.length === 0) {
        container.innerHTML = '<div class="text-slate-600">尚無故障或降級轉移記錄。</div>';
        return;
      }

      container.innerHTML = logs.map(l => {
        let colorClass = 'text-slate-300';
        if (l.type === 'failover') colorClass = 'text-amber-400';
        if (l.type === 'exhausted') colorClass = 'text-rose-400';
        if (l.type === 'error') colorClass = 'text-rose-300';

        return \`
          <div class="flex gap-2">
            <span class="text-slate-500">[\${l.time}]</span>
            <span class="\${colorClass}">\${l.message}</span>
          </div>
        \`;
      }).join('');
    }

    async function toggleModel(modelId) {
      await fetch('/api/admin/toggle-model', {
        method: 'POST',
        headers: { 'Authorization': getAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId })
      });
      fetchData();
    }

    async function toggleKey(key) {
      await fetch('/api/admin/toggle-key', {
        method: 'POST',
        headers: { 'Authorization': getAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: activeProvider, key: key })
      });
      fetchData();
    }

    async function resetCooldown() {
      await fetch('/api/admin/reset-cooldown', {
        method: 'POST',
        headers: { 'Authorization': getAuth() }
      });
      alert('所有 Key 的冷卻狀態已清除！');
      fetchData();
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

    async function clearLogs() {
      if (!confirm('確定要清空日誌嗎？')) return;
      await fetch('/api/admin/clear-logs', {
        method: 'POST',
        headers: { 'Authorization': getAuth() }
      });
      fetchData();
    }
  </script>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
