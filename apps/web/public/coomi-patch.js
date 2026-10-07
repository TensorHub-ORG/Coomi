// ============================================
// Coomi ChatView Patch v12 - CSS动画 + 收回触发
// ============================================

(function() {
  "use strict";
  
  let lastClickX = 0;
  let lastClickY = 0;
  
  document.addEventListener("click", function(e) {
    lastClickX = e.clientX;
    lastClickY = e.clientY;
  });
  
  // ========== DeepTrace ==========
  const DeepTrace = {
    traces: [],
    metrics: { totalRequests: 0, totalTokens: 0, avgLatency: 0, tokensPerSecond: 0, errorRate: 0 },
    maxTraces: 50,
    
    addTrace(type, name, meta) {
      meta = meta || {};
      this.traces.unshift({ id: Date.now() + Math.random(), type, name, meta, timestamp: Date.now() });
      if (this.traces.length > this.maxTraces) this.traces.pop();
      this.updateMetrics();
    },
    
    updateMetrics() {
      const responses = this.traces.filter(t => t.type === "response");
      this.metrics.totalRequests = this.traces.filter(t => t.type === "request").length;
      this.metrics.totalTokens = responses.reduce((s, r) => s + (r.meta.tokens || 0), 0);
      const lats = responses.map(r => r.meta.latency || 0).filter(l => l > 0);
      this.metrics.avgLatency = lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length : 0;
      const recent = responses.slice(0, 5);
      if (recent.length) {
        const tokens = recent.reduce((s, r) => s + (r.meta.tokens || 0), 0);
        const time = recent.reduce((s, r) => s + (r.meta.latency || 0), 0) / 1000;
        this.metrics.tokensPerSecond = time > 0 ? Math.round(tokens / time) : 0;
      }
      this.metrics.errorRate = this.traces.length ? (this.traces.filter(t => t.type === "error").length / this.traces.length * 100) : 0;
    }
  };
  window.CoomiDeepTrace = DeepTrace;
  
  function interceptWebSocket() {
    const OrigWS = window.WebSocket;
    window.WebSocket = function(url, protos) {
      const ws = new OrigWS(url, protos);
      const turn = { startedAt: 0, firstTokenAt: 0, outputChars: 0 };
      const origSend = ws.send.bind(ws);
      ws.send = function(data) {
        try { const m=JSON.parse(data),p=m.payload||{}; if(m.type==="command"&&p.command==="send_message"){turn.startedAt=performance.now();turn.firstTokenAt=0;turn.outputChars=0;DeepTrace.addTrace("request","User",{tokens:Math.ceil(String(p.text||"").length/4)});} } catch(e) {}
        return origSend(data);
      };
      ws.addEventListener("message", function(e) {
        try { const raw=JSON.parse(e.data),d=raw.payload||raw;
          if(d.event_type==="text_chunk"){if(!turn.firstTokenAt)turn.firstTokenAt=performance.now();turn.outputChars+=String(d.content||"").length;}
          else if(d.event_type==="tool_start") DeepTrace.addTrace("tool",d.tool_name||"Tool",{});
          else if(d.event_type==="turn_end"){const elapsed=Math.max(1,performance.now()-(turn.startedAt||performance.now()));const tokens=d.usage?.output_tokens||Math.ceil(turn.outputChars/4);DeepTrace.addTrace("response","Turn",{tokens,latency:elapsed});}
        } catch(ex) {}
      });
      return ws;
    };
    window.WebSocket.prototype=OrigWS.prototype;
    Object.keys(OrigWS).forEach(k=>window.WebSocket[k]=OrigWS[k]);
  }
  
  function injectDeepTraceToUsage() {
    const usageMenu = document.querySelector(".usage-menu");
    if (!usageMenu) return false;
    
    let section = usageMenu.querySelector(".deeptrace-section");
    if (!section) {
      section = document.createElement("div");
      section.className = "deeptrace-section";
      section.innerHTML = `
        <div class="deeptrace-header">
          <span class="deeptrace-dot"></span>
          <span class="deeptrace-title">DeepTrace</span>
        </div>
        <div class="deeptrace-metrics">
          <div class="deeptrace-metric"><span id="dt-req">0</span><label>请求</label></div>
          <div class="deeptrace-metric"><span id="dt-tok">0</span><label>Token</label></div>
          <div class="deeptrace-metric"><span id="dt-lat">0ms</span><label>延迟</label></div>
          <div class="deeptrace-metric"><span id="dt-spd">0 t/s</span><label>速度</label></div>
        </div>
      `;
      usageMenu.insertBefore(section, usageMenu.firstChild);
    }
    
    section.style.display = "block";
    section.style.visibility = "visible";
    section.style.opacity = "1";
    
    return true;
  }
  
  function updateDeepTraceUI() {
    const r = document.getElementById("dt-req"), t = document.getElementById("dt-tok");
    const l = document.getElementById("dt-lat"), s = document.getElementById("dt-spd");
    if (r) r.textContent = DeepTrace.metrics.totalRequests;
    if (t) t.textContent = DeepTrace.metrics.totalTokens.toLocaleString();
    if (l) l.textContent = Math.round(DeepTrace.metrics.avgLatency) + "ms";
    if (s) {
      const spd = DeepTrace.metrics.tokensPerSecond;
      s.textContent = spd + " t/s";
      s.style.color = spd > 50 ? "var(--ok,#1f9d6b)" : spd > 20 ? "var(--blue,#2d61c6)" : "var(--orange,#d47458)";
    }
  }
  
  function setupUsageObserver() {
    const observer = new MutationObserver(function(mutations) {
      mutations.forEach(function(mutation) {
        if (mutation.type === "childList") {
          mutation.addedNodes.forEach(function(node) {
            if (node.nodeType === 1 && node.classList && node.classList.contains("usage-menu")) {
              setTimeout(() => {
                injectDeepTraceToUsage();
                updateDeepTraceUI();
              }, 100);
            }
          });
        }
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  
  function setupUsageClickListener() {
    document.addEventListener("click", function(e) {
      const usageBtn = e.target.closest(".usage-button") || e.target.closest(".usage-ring");
      if (usageBtn) {
        for (let i = 0; i < 5; i++) {
          setTimeout(() => {
            injectDeepTraceToUsage();
            updateDeepTraceUI();
          }, i * 100 + 50);
        }
      }
    });
  }
  
  // ========== 输入气泡动画 ==========
  function initBubbleAnimation() {
    const input = document.querySelector(".input");
    if (!input) return;
    let timer = null, bubbles = null;
    input.addEventListener("input", function() {
      const field = input.closest(".field");
      if (!field) return;
      field.classList.add("typing");
      if (!bubbles) {
        bubbles = document.createElement("div");
        bubbles.className = "bubble-particles";
        for (let i = 0; i < 5; i++) bubbles.innerHTML += '<span class="bubble-particle"></span>';
        field.appendChild(bubbles);
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        field.classList.remove("typing");
        if (bubbles) { bubbles.remove(); bubbles = null; }
      }, 1500);
    });
  }
  
  // ========== 流式输出动画 ==========
  function initStreamAnimation() {
    const target = document.querySelector(".stream") || document.querySelector(".chat");
    if (!target) return;
    const obs = new MutationObserver(mutations => {
      mutations.forEach(m => {
        if (m.type === "childList") m.addedNodes.forEach(n => {
          if (n.nodeType === 1) applyStreamAnim(n);
        });
      });
    });
    obs.observe(target, { childList: true, subtree: true });
  }
  
  const seenTextNodes = new WeakSet();
  function applyStreamAnim(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    const nodes = [];
    let n;
    while (n = walker.nextNode()) {
      // 已包裹的 span.stream-word 内的文本节点跳过，否则换行动画会自我触发无限循环。
      if (n.parentElement && n.parentElement.classList.contains("stream-word")) continue;
      if (n.textContent.trim() && !seenTextNodes.has(n)) { seenTextNodes.add(n); nodes.push(n); }
    }
    nodes.forEach(tn => {
      const text = tn.textContent, parent = tn.parentNode;
      const parts = text.split(/(\s+)/);
      const frag = document.createDocumentFragment();
      parts.forEach((p, i) => {
        if (p.trim()) {
          const span = document.createElement("span");
          span.className = "stream-word";
          span.style.animationDelay = (i * 0.03) + "s";
          span.textContent = p;
          frag.appendChild(span);
        } else {
          frag.appendChild(document.createTextNode(p));
        }
      });
      parent.replaceChild(frag, tn);
    });
  }
  
  // ========== 初始化 ==========
  function init() {
    interceptWebSocket();
    setupUsageObserver();
    setupUsageClickListener();
    initBubbleAnimation();
    initStreamAnimation();
    
    setInterval(updateDeepTraceUI, 500);
    
    setInterval(() => {
      const usageMenu = document.querySelector(".usage-menu");
      if (usageMenu) {
        injectDeepTraceToUsage();
      }
    }, 1000);
    
    console.log("[Coomi] v12 loaded");
  }
  
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

// ============================================
// Coomi Patch v13 - 超载模式样式（本地能力入口已移入 Composer）
// ============================================
(function() {
  "use strict";
  function initV13() {
    var style = document.createElement("style");
    style.textContent = [
      ".production-pill.on { color: #ff3b30 !important; background: rgba(255,59,48,0.12) !important; }",
      ".production-pill.on svg { color: #ff3b30 !important; }",
      ".local-actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px; margin-bottom:8px; }",
      ".local-actions .qchip { justify-content:flex-start; width:100%; }"
    ].join("\n");
    document.head.appendChild(style);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initV13);
  else initV13();
})();
