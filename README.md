# Gemini Reverse Proxy for Deno Deploy

[![Deploy on Deno](https://deno.com/button)](https://console.deno.com/new?clone=https://github.com/YOUR_GITHUB_USERNAME/YOUR_REPOSITORY_NAME)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Deno Deploy](https://img.shields.io/badge/Platform-Deno%20Deploy-black.svg)](https://deno.com/deploy)

A lightweight, serverless reverse proxy and protocol translator for Google Gemini running on **Deno Deploy**. It bridges OpenAI-compatible clients (Cline, Roo Code, Continue, Cursor, ChatBox) with Google Gemini APIs, bypasses geo-location restrictions natively, and features built-in multi-key rotation backed by **Deno KV**.

---

## ✨ Features

* **🌍 Geo-Restriction Bypass**: Runs natively across Deno's global Edge network, resolving regional Google API blocks.
* **⚡ Native Deno KV Integration**: Seamlessly saves API key pools, daily metrics, and rate-limit cooldown states using Deno KV without external database setup.
* **🔄 OpenAI Protocol Translation**: Complete compatibility for `/v1/chat/completions` and `/v1/models` with SSE streaming and multimodal image processing.
* **🛡️ Smart Circuit Breaker**: Automatically flags `429` / `503` rate limits with a temporary cooldown and seamlessly fails over to healthy keys.
* **📊 Visual Admin Dashboard (`/admin`)**: Interactive web UI to add/delete API keys, inspect per-model call counts, and copy connection endpoints.

---

## 🚀 One-Click Deployment

Click the button below to fork and deploy directly to your Deno Deploy account:

[![Deploy on Deno](https://deno.com/button)](https://console.deno.com/new?clone=https://github.com/YOUR_GITHUB_USERNAME/YOUR_REPOSITORY_NAME)

> **Note**: Replace `YOUR_GITHUB_USERNAME/YOUR_REPOSITORY_NAME` with your actual GitHub repository URL.

---

## 🛠️ Step-by-Step Manual Setup

### 1. Repository Structure
Ensure your GitHub repository has the following file layout:

```text
├── main.js       # The proxy source code
└── README.md     # Documentation
